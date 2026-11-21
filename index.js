import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import Stripe from "stripe";

const app = express();
const port = 8000;
const client = new MongoClient(process.env.MONGODB_URI);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

connectToMongoDB();

const db = client.db("wedplan");
const userCollection = db.collection("user");
const serviceCollection = db.collection("services");
const bookingCollection = db.collection("bookings");
const transactionCollection = db.collection("transaction");
const sessionCollection = db.collection("session");

app.use(cors());

//stripe webhook

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    // 1. Verify Stripe webhook signature
    try {
      const signature = req.headers["stripe-signature"];

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );

      console.log("Received Stripe event:", event.type);
    } catch (err) {
      console.error("Webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 2. Handle successful Checkout payment
    if (event.type === "checkout.session.completed") {
      try {
        const session = event.data.object;
        console.log("Payment status:", session.payment_status);
        console.log("Session ID:", session.id);
        console.log("Payment metadata:", session.metadata);
        // Confirm payment details
        if (
          session.payment_status !== "paid" ||
          session.mode !== "payment" ||
          session.amount_total !== 9900 ||
          session.currency !== "usd"
        ) {
          console.log("Payment not eligible for activation");
          return res.json({ received: true });
        }

        const paymentId = session.metadata?.paymentId;
        const userId = session.metadata?.userId;

        if (!paymentId || !userId) {
          console.error("Missing payment metadata");
          return res.status(400).send("Missing payment metadata");
        }

        const txId = toObjectId(paymentId);

        if (!txId) {
          console.error("Invalid payment ID:", paymentId);
          return res.status(400).send("Invalid payment ID");
        }

        // 3. Find the original unpaid transaction
        const transaction = await transactionCollection.findOne({
          _id: txId,
          userId,
          sessionId: session.id,
          status: "unpaid",
          amount: 99,
          currency: "usd",
          plan: "premium",
        });

        // Already processed or transaction not found
        if (!transaction) {
          console.log("Transaction already processed or not found:", paymentId);
          return res.json({ received: true });
        }

        console.log("Transaction found:", transaction);

        // 4. Calculate subscription expiry
        const paidAt = new Date();
        const expiresAt = new Date(paidAt);
        expiresAt.setDate(expiresAt.getDate() + 90);

        // 5. Mark transaction as paid
        const updateResult = await transactionCollection.updateOne(
          {
            _id: txId,
            userId,
            sessionId: session.id,
            status: "unpaid",
          },
          {
            $set: {
              status: "paid",
              paidAt,
              subscriptionExpiresAt: expiresAt,
              paymentIntent: session.payment_intent,
            },
          },
        );

        console.log("Transaction update result:", updateResult);

        // 6. Activate premium only once
        if (updateResult.modifiedCount === 1) {
          const userObjId = toObjectId(userId);

          const userResult = await userCollection.updateOne(
            userObjId ? { _id: userObjId } : { _id: userId },
            {
              $set: {
                subscriptionPlan: "premium",
                subscriptionExpiresAt: expiresAt,
              },
            },
          );

          if (userResult.matchedCount !== 1) {
            throw new Error("User not found during subscription activation");
          }

          console.log("Premium subscription activated:", userId);
        }
      } catch (err) {
        console.error("Webhook processing error:", err);

        // Return 500 so Stripe retries the webhook.
        return res.status(500).json({
          error: "Webhook processing failed",
        });
      }
    }

    return res.json({ received: true });
  },
);

app.use(express.json());

/** Fields a vendor is allowed to change on an existing listing. */
const UPDATABLE_SERVICE_FIELDS = [
  "title",
  "category",
  "price",
  "description",
  "imageUrls",
  "isAvailable",
];

/** Converts a route id to an ObjectId, returning null when it is malformed. */
function toObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

//middleware

//checks if the token is verified
const verifyToken = async (req, res, next) => {
  // Check for the Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Extract the token from the header
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Check if the token exists in the user collection
  const query = { token };
  const user = await sessionCollection.findOne(query);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Attach the user object to the request for further use

  req.user = user;

  next();
};

//must call this after verify token to verify user
//Identify who the user is or find the user in the database of usercollection
const verifyUser = async (req, res, next) => {
  const userId = toObjectId(req.user.userId);
  const findUser = await userCollection.findOne({ _id: userId });

  if (!findUser) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req.findUser = findUser;

  next();
};

//checks if the user is a vendor
const verifyVendor = async (req, res, next) => {
  if (req.findUser.accountType !== "vendor") {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

//checks vendor  authorization of how many posts can a vendor have if his subscription plan is free
const vendorAuthorization = async (req, res, next) => {
  req.subscriptionPlan = req.findUser.subscriptionPlan;
  const vendorPostingCount = await serviceCollection.countDocuments({
    vendorId: req.findUser._id.toString(),
  });

  if (vendorPostingCount >= 3 && req.subscriptionPlan === "free") {
    return res
      .status(401)
      .json(
        "You've reached your free post limit! Upgrade to Premium to keep posting and unlock unlimited access.",
      );
  }
  next();
};

//checks that if the real vendor is trying to update the service
const isAuthenticVendor = async (req, res, next) => {
  const id = toObjectId(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "Invalid service id" });
  }
  const findUserById = await serviceCollection.findOne({ _id: id });
  if (findUserById.vendorId === req.findUser._id) {
    res.status(403).json({ message: "Forbidden" });
  }
  next();
};

//checks if the user is customer , not vendor or admin
const verifyCustomer = async (req, res, next) => {
  // console.log(req.findUser.accountType)
  if (req.findUser.accountType !== "customer") {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

//checks if the customer is the customer who is requesting
const realCustomer = async (req, res, next) => {
  const { customerId } = req.query;
  if (customerId !== req.findUser._id.toString()) {
    return res.status(403).json({ message: "Forbidden" });
  }

  next();
};

// //checks if the customer is authenticated to delete booking
// const isRealCustomerBookingDelete = async(req,res,next) => {
//    const _id = toObjectId(req.params.id);
//    const findBooking = await bookingCollection.findOne()

// }

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post(
  "/services",
  verifyToken,
  verifyUser,
  verifyVendor,
  vendorAuthorization,
  async (req, res) => {
    try {
      const data = req.body ?? {};
      const now = new Date().toISOString();

      const result = await serviceCollection.insertOne({
        ...data,
        price: Number(data.price) || 0,
        imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls : [],
        // New listings wait for admin approval and are bookable until toggled off.
        status: "pending",
        isAvailable: true,
        createdAt: now,
        updatedAt: now,
      });

      res.status(201).json({
        success: true,
        message: "Service created successfully",
        insertedId: result.insertedId,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

app.get("/services", async (req, res) => {
  try {
    const { vendorId, status } = req.query;
    const filter = {};
    // const filter = vendorId ? { vendorId: String(vendorId) } : {};
    if (vendorId) {
      filter.vendorId = vendorId;
    }
    if (status) {
      filter.status = status;
    }
    const services = await serviceCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(services);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/services/:id", verifyToken, verifyUser, async (req, res) => {
  try {
    const _id = toObjectId(req.params.id);
    if (!_id) {
      return res.status(400).json({ message: "Invalid service id" });
    }

    const service = await serviceCollection.findOne({ _id });

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json(service);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.put(
  "/services/:id",
  verifyToken,
  verifyUser,
  verifyVendor,
  isAuthenticVendor,
  async (req, res) => {
    try {
      const _id = req.params.id;
      // Only copy whitelisted fields so documents like _id/vendorId stay intact.
      const body = req.body ?? {};
      const updates = {};
      for (const field of UPDATABLE_SERVICE_FIELDS) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      if (updates.price !== undefined) {
        updates.price = Number(updates.price);
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      updates.updatedAt = new Date().toISOString();

      const updated = await serviceCollection.findOneAndUpdate(
        { _id: new ObjectId(_id) },
        { $set: updates },
        { returnDocument: "after" },
      );

      if (!updated) {
        return res.status(404).json({ message: "Service not found" });
      }

      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

app.delete(
  "/services/:id",
  verifyToken,
  verifyUser,
  verifyVendor,
  isAuthenticVendor,
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid service id" });
      }

      const result = await serviceCollection.deleteOne({ _id });

      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "Service not found" });
      }

      res.json({ success: true, deletedId: req.params.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

app.post(
  "/bookings",
  verifyToken,
  verifyUser,
  verifyCustomer,
  async (req, res) => {
    try {
      const data = req.body;
      const now = new Date().toISOString();

      const result = await db.collection("bookings").insertOne({
        ...data,
        createdAt: now,
      });

      res.status(201).json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

app.get(
  "/bookings",
  verifyToken,
  verifyUser,
  verifyCustomer,
  realCustomer,
  async (req, res) => {
    try {
      const { serviceId, customerId } = req.query;
      const filter = {};
      if (serviceId) {
        filter.serviceId = serviceId;
      }
      if (customerId) {
        filter.customerId = customerId;
      }

      // // Service-scoped lookups back the "already requested?" panel, which expects one record.
      // if (serviceId) {
      //   const booking = await bookingCollection.find(filter)
      //   return res.json(booking)
      // }

      // Customer lookups list every request, newest first.
      const bookings = await bookingCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      res.json(bookings);
    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

/** Deletes a customer's booking request — only while it is still pending. */
app.delete(
  "/bookings/:id",
  verifyToken,
  verifyUser,
  verifyCustomer,
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid booking id" });
      }

      const booking = await bookingCollection.findOne({ _id });
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (req.findUser._id.toString() !== booking.customerId) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const status = String(
        booking.bookingStatus ?? booking.status ?? "pending",
      ).toLowerCase();

      if (status !== "pending") {
        return res
          .status(403)
          .json({ message: "Only pending bookings can be deleted" });
      }

      await bookingCollection.deleteOne({ _id });

      res.json({ success: true, deletedId: req.params.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// app.post("/create-checkout-session", verifyToken,verifyUser, async (req, res) => {
//   try {
//     const payload = req.body ?? {};
//     console.log("Create checkout session payload:", payload);

//     if (!payload.id && !payload.email) {
//       return res.status(400).json({ error: "User ID or email is required" });
//     }

//     // Lookup user by ObjectId, string _id, or email
//     const queryConditions = [];
//     const objId = toObjectId(payload.id);
//     if (objId) queryConditions.push({ _id: objId });
//     if (payload.id) queryConditions.push({ _id: payload.id });
//     if (payload.email) queryConditions.push({ email: payload.email });

//     const user = await userCollection.findOne({ $or: queryConditions });

//     if (!user) {
//       return res.status(404).json({ error: "User not found" });
//     }

//     const userId = (user._id || payload.id).toString();
//     const userEmail = user.email || payload.email;

//     // Record transaction in database with status 'unpaid'
//     const userStatusInfo = {
//       userId,
//       userEmail,
//       amount: 99,
//       plan: "free",
//       status: "unpaid",
//       createdAt: new Date(),
//     };
//     const paymentConfirmationResult =
//       await transactionCollection.insertOne(userStatusInfo);

//     // Ensure client URL has protocol
//     let clientUrl = process.env.CLIENT_URL ;
//     if (!clientUrl.startsWith("http://") && !clientUrl.startsWith("https://")) {
//       clientUrl = `http://${clientUrl}`;
//     }

//     // Create Stripe Checkout session
//     const session = await stripe.checkout.sessions.create({
//       success_url: `${clientUrl}/dashboard/vendor/success_payment?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${clientUrl}/dashboard/vendor/cancel_payment`,
//       customer_email: userEmail,
//       line_items: [
//         {
//           price_data: {
//             currency: "usd",
//             unit_amount: 99 * 100, // $99.00 in cents
//             product_data: {
//               name: "WedPlan Premium Vendor Membership",
//               description:
//                 "Unlimited service listings and verified vendor badge",
//             },
//           },
//           quantity: 1,
//         },
//       ],
//       mode: "payment",
//       metadata: {
//         paymentId: paymentConfirmationResult.insertedId.toString(),
//         userId,
//         userEmail,
//       },
//     });

//     const retrieveStripeSession = await stripe.checkout.sessions.retrieve(
//       session.id,
//     );

//     const { status, customer_email, payment_status, metadata, payment_intent } = retrieveStripeSession

//     // console.log(
//     //   status,
//     //   customer_email,
//     //   payment_status,
//     //   metadata,
//     //   payment_intent,
//     // );

//     // If there's session.id after stripe checking
//     // if (session && session.id) {
//     //   const ninetyDays = new Date();
//     //   ninetyDays.setDate(ninetyDays.getDate() + 90);

//     //   // 1. Change the collection "transaction" status to paid
//     //   await transactionCollection.updateOne(
//     //     { _id: paymentConfirmationResult.insertedId },
//     //     {
//     //       $set: {
//     //         status: "paid",
//     //         sessionId: session.id,
//     //         paidAt: new Date(),
//     //       },
//     //     },
//     //   );

//       // 2. Update user collection subscriptionPlan : "Premium" and add subscriptionExpiresAt : (after 90 days)
//     //   await userCollection.updateOne(
//     //     { _id: user._id },
//     //     {
//     //       $set: {
//     //         subscriptionPlan: "premium",
//     //         subscriptionExpiresAt: ninetyDays,
//     //       },
//     //     },
//     //   );
//     // }
//     // console.log("session",session)
//     // console.log("retrieved session",retrieveStripeSession)
//     res.json({ success: true, url: session.url, sessionId: session.id });
//   } catch (err) {
//     console.error("Failed to create checkout session:", err);
//     res.status(500).json({
//       error: "Internal server error",
//       message: err.message || "Failed to create checkout session",
//     });
//   }
// });

app.post(
  "/create-checkout-session",
  verifyToken,
  verifyUser,
  async (req, res) => {
    let paymentId;

    try {
      const payload = req.body ?? {};

      if (!payload.id && !payload.email) {
        return res.status(400).json({
          error: "User ID or email is required",
        });
      }

      // Find user
      const queryConditions = [];

      const objId = toObjectId(payload.id);

      if (objId) {
        queryConditions.push({ _id: objId });
      }

      if (payload.id) {
        queryConditions.push({ _id: payload.id });
      }

      if (payload.email) {
        queryConditions.push({ email: payload.email });
      }

      const user = await userCollection.findOne({
        $or: queryConditions,
      });

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      const userId = user._id.toString();
      const userEmail = user.email;

      if (!userEmail) {
        return res.status(400).json({
          error: "User email is missing",
        });
      }

      // Check existing subscription
      if (
        user.subscriptionPlan === "premium" &&
        user.subscriptionExpiresAt &&
        new Date(user.subscriptionExpiresAt) > new Date()
      ) {
        return res.status(400).json({
          error: "You already have an active premium subscription",
        });
      }

      // Create unpaid transaction
      const transactionResult = await transactionCollection.insertOne({
        userId,
        userEmail,
        amount: 99,
        currency: "usd",
        plan: "premium",
        status: "unpaid",
        createdAt: new Date(),
      });

      paymentId = transactionResult.insertedId;

      // Validate frontend URL
      const clientUrl = new URL(process.env.CLIENT_URL).origin;

      // Create Stripe Checkout Session
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "payment",

        success_url:
          `${clientUrl}/dashboard/vendor/success_payment` +
          `?session_id={CHECKOUT_SESSION_ID}`,

        cancel_url: `${clientUrl}/dashboard/vendor/cancel_payment`,

        customer_email: userEmail,

        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 9900,

              product_data: {
                name: "WedPlan Premium Vendor Membership",
                description:
                  "Unlimited service listings and verified vendor badge",
              },
            },

            quantity: 1,
          },
        ],

        metadata: {
          paymentId: paymentId.toString(),
          userId,
          userEmail,
        },
      });

      // Save Stripe session ID in transaction
      await transactionCollection.updateOne(
        { _id: paymentId },
        {
          $set: {
            sessionId: checkoutSession.id,
          },
        },
      );

      // Return checkout URL to frontend
      return res.status(200).json({
        success: true,
        url: checkoutSession.url,
        sessionId: checkoutSession.id,
      });
    } catch (err) {
      console.error("Checkout session error:", err);

      // Mark failed checkout creation
      if (paymentId) {
        await transactionCollection
          .updateOne(
            { _id: paymentId, status: "unpaid" },
            {
              $set: {
                status: "failed",
                failedAt: new Date(),
              },
            },
          )
          .catch(console.error);
      }

      return res.status(500).json({
        error: "Failed to create checkout session",
      });
    }
  },
);

/**
 * Verify payment endpoint:
 * Checks session with Stripe after checkout redirect and ensures transaction
 * status is updated to "paid" and user subscription is set to "Premium" with 90-day expiry.
 */
// app.post("/verify-payment", async (req, res) => {
//   try {
//     const { sessionId } = req.body ?? {};
//     if (!sessionId) {
//       return res.status(400).json({ error: "sessionId is required" });
//     }

//     // Retrieve and check session from Stripe
//     const session = await stripe.checkout.sessions.retrieve(sessionId);

//     if (session && session.id) {
//       const ninetyDays = new Date();
//       ninetyDays.setDate(ninetyDays.getDate() + 90);

//       const userId = session.metadata?.userId;
//       const paymentId = session.metadata?.paymentId;

//       // 1. Change the collection "transaction" status to paid
//       if (paymentId) {
//         const txId = toObjectId(paymentId);
//         await transactionCollection.updateOne(
//           txId ? { _id: txId } : { _id: paymentId },
//           {
//             $set: {
//               status: "paid",
//               sessionId: session.id,
//               paidAt: new Date(),
//             },
//           },
//         );
//       } else {
//         await transactionCollection.updateMany(
//           { sessionId: session.id },
//           {
//             $set: {
//               status: "paid",
//               paidAt: new Date(),
//             },
//           },
//         );
//       }

//       // 2. Update user collection subscriptionPlan: "Premium" and subscriptionExpiresAt: (after 90 days)
//       if (userId) {
//         const userObjId = toObjectId(userId);
//         await userCollection.updateOne(
//           userObjId ? { _id: userObjId } : { _id: userId },
//           {
//             $set: {
//               subscriptionPlan: "premium",
//               subscriptionExpiresAt: ninetyDays,
//             },
//           },
//         );
//       }

//       return res.json({
//         success: true,
//         message: "Subscription activated successfully",
//         subscriptionPlan: "premium",
//         subscriptionExpiresAt: ninetyDays,
//       });
//     }

//     res.status(400).json({ error: "Invalid Stripe session" });
//   } catch (err) {
//     console.error("Payment verification failed:", err);
//     res.status(500).json({
//       error: "Internal server error",
//       message: err.message || "Failed to verify payment",
//     });
//   }
// });

app.post("/verify-payment", verifyToken, verifyUser, async (req, res) => {
  try {
    const { sessionId } = req.body ?? {};

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required",
      });
    }

    // 1. Retrieve Checkout Session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // 2. Verify that this session belongs to the logged-in user
    const userId = req.findUser._id.toString();

    if (session.metadata?.userId !== userId) {
      return res.status(403).json({
        error: "You are not authorized to access this payment",
      });
    }

    if (
      session.mode !== "payment" ||
      session.amount_total !== 9900 ||
      session.currency !== "usd"
    ) {
      return res.status(400).json({
        error: "Invalid payment session",
      });
    }

    // 3. Find the corresponding transaction
    const paymentId = session.metadata?.paymentId;
    const txId = toObjectId(paymentId);

    if (!txId) {
      return res.status(400).json({
        error: "Invalid payment reference",
      });
    }

    const transaction = await transactionCollection.findOne({
      _id: txId,
      userId,
      sessionId: session.id,
      amount: 99,
      currency: "usd",
      plan: "premium",
    });

    if (!transaction) {
      return res.status(404).json({
        error: "Payment transaction not found",
      });
    }

    // 4. Check actual payment status
    if (session.payment_status !== "paid" || transaction.status !== "paid") {
      return res.status(200).json({
        success: false,
        status: "pending",
        message: "Payment is awaiting confirmation",
      });
    }

    // 5. Return actual subscription details from MongoDB
    const user = await userCollection.findOne({
      _id: req.findUser._id,
    });

    return res.status(200).json({
      success: true,
      status: "paid",
      message: "Payment confirmed successfully",
      subscriptionPlan: user?.subscriptionPlan,
      subscriptionExpiresAt: user?.subscriptionExpiresAt,
    });
  } catch (err) {
    console.error("Payment verification failed:", err);

    return res.status(500).json({
      error: "Failed to verify payment",
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on Port ${port}`);
});
