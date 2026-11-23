import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import Stripe from "stripe";

const app = express();
const port = 8000;
// const client = new MongoClient(process.env.MONGODB_URI);
const globalForMongo = globalThis;

const client =
  globalForMongo.mongoClient ??
  new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5, // free Atlas has a connection limit
    serverSelectionTimeoutMS: 10000, // fail fast instead of waiting 30s
    maxIdleTimeMS: 5000, // drop idle connections before they go stale
  });

globalForMongo.mongoClient = client;
await client.connect();
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

const PREMIUM_PRICE_CENTS = 9900;
const PREMIUM_DURATION_DAYS = 90;

/**
 * Marks the transaction for a paid Checkout Session as "paid" and upgrades the
 * matching user to Premium for 90 days. Idempotent, so the Stripe webhook and
 * /verify-payment can both call it without activating the plan twice.
 */
async function activatePremiumSubscription(session) {
  const userId = session?.metadata?.userId;
  const paymentId = session?.metadata?.paymentId;

  if (!userId || !paymentId) {
    return { found: false, reason: "missing-metadata" };
  }

  const txId = toObjectId(paymentId);

  if (!txId) {
    return { found: false, reason: "invalid-payment-id" };
  }

  // Find the original transaction created by /create-checkout-session
  const transaction = await transactionCollection.findOne({
    _id: txId,
    userId,
    sessionId: session.id,
    amount: 99,
    currency: "usd",
    plan: "premium",
  });

  if (!transaction) {
    return { found: false, reason: "transaction-not-found" };
  }

  let paidTransaction = transaction;

  // Only stamp the transaction the first time; later calls reuse the expiry
  if (transaction.status !== "paid") {
    const paidAt = new Date();
    const expiresAt = new Date(paidAt);
    expiresAt.setDate(expiresAt.getDate() + PREMIUM_DURATION_DAYS);

    const updateResult = await transactionCollection.updateOne(
      { _id: txId, status: "unpaid" },
      {
        $set: {
          status: "paid",
          paidAt,
          subscriptionExpiresAt: expiresAt,
          paymentIntent: session.payment_intent ?? null,
        },
      },
    );

    paidTransaction =
      updateResult.modifiedCount === 1
        ? {
            ...transaction,
            status: "paid",
            paidAt,
            subscriptionExpiresAt: expiresAt,
          }
        : await transactionCollection.findOne({ _id: txId });
  }

  const subscriptionExpiresAt =
    paidTransaction?.subscriptionExpiresAt ??
    (() => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + PREMIUM_DURATION_DAYS);
      return expiresAt;
    })();

  const userObjId = toObjectId(userId);
  const userResult = await userCollection.updateOne(
    userObjId ? { _id: userObjId } : { _id: userId },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt,
      },
    },
  );

  if (userResult.matchedCount !== 1) {
    return { found: true, userId, reason: "user-not-found" };
  }

  return { found: true, userId, subscriptionExpiresAt };
}

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
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      try {
        const session = event.data.object;
        // console.log("Payment status:", session.payment_status);
        // console.log("Session ID:", session.id);
        // console.log("Payment metadata:", session.metadata);

        // Confirm payment details
        if (
          session.payment_status !== "paid" ||
          session.mode !== "payment" ||
          session.amount_total !== PREMIUM_PRICE_CENTS ||
          session.currency !== "usd"
        ) {
          console.log("Payment not eligible for activation");
          return res.json({ received: true });
        }

        // 3. Mark transaction paid + activate premium (idempotent)
        const result = await activatePremiumSubscription(session);

        if (!result.found) {
          console.error(
            "Paid session has no matching transaction:",
            result.reason,
            session.id,
          );
          return res.json({ received: true });
        }

        if (result.reason === "user-not-found") {
          throw new Error("User not found during subscription activation");
        }

        console.log("Premium subscription activated:", result.userId);
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

/** Status values an admin may assign when moderating a listing. */
const MODERABLE_SERVICE_STATUSES = ["active", "declined"];

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

const isAuthenticBookingVendor = async (req, res, next) => {
  const { vendorId} = req.query;
  if (vendorId !== req.findUser._id.toString()) {
    return res.status(403).json({ message: "Forbidden" });
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

//checks if the user is an admin — role is written by the Better Auth admin plugin
const verifyAdmin = async (req, res, next) => {
  const role = String(req.findUser?.role ?? "").toLowerCase();
  if (role !== "admin") {
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



app.get("/featured", async (req, res) => {
  try {
    const result = await serviceCollection
      .find({ status: "active" })
      .limit(6)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});



app.get("/services", async (req, res) => {
  try {
    const { vendorId, status, search, category, location, sort } = req.query;
    const filter = {};
    // const filter = vendorId ? { vendorId: String(vendorId) } : {};
    if (vendorId) {
      filter.vendorId = vendorId;
    }
    if (status && status !== "all") {
      filter.status = status;
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    if (location && typeof location === "string" && location.trim()) {
      filter.location = { $regex: location.trim(), $options: "i" };
    }
    if (search && typeof search === "string" && search.trim()) {
      const searchRegex = { $regex: search.trim(), $options: "i" };
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { location: searchRegex },
        { vendorName: searchRegex },
        { vendorEmail: searchRegex },
      ];
    }

    // Sort options mapping
    let sortOption = { createdAt: -1 };
    if (sort === "price-low" || sort === "price-asc") {
      sortOption = { price: 1 };
    } else if (sort === "price-high" || sort === "price-desc") {
      sortOption = { price: -1 };
    } else if (sort === "oldest") {
      sortOption = { createdAt: 1 };
    } else if (sort === "name-asc") {
      sortOption = { title: 1 };
    } else if (sort === "name-desc") {
      sortOption = { title: -1 };
    } else if (sort === "newest") {
      sortOption = { createdAt: -1 };
    }

    const services = await serviceCollection
      .find(filter)
      .sort(sortOption)
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

/**
 * Admin: Get high-level platform statistics and metrics.
 */
app.get(
  "/admin/stats",
  verifyToken,
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const [
        totalUsers,
        totalVendors,
        totalCustomers,
        totalServices,
        pendingServices,
        totalTransactions,
        recentUsers,
      ] = await Promise.all([
        userCollection.countDocuments({}),
        userCollection.countDocuments({
          $or: [{ accountType: "vendor" }, { role: "vendor" }],
        }),
        userCollection.countDocuments({
          $or: [
            { accountType: "customer" },
            { accountType: { $exists: false }, role: { $nin: ["admin", "vendor"] } },
          ],
        }),
        serviceCollection.countDocuments({}),
        serviceCollection.countDocuments({ status: "pending" }),
        transactionCollection.countDocuments({}),
        userCollection
          .find({}, { projection: { password: 0 } })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray(),
      ]);

      res.json({
        totalUsers,
        totalVendors,
        totalCustomers,
        totalServices,
        pendingServices,
        totalTransactions,
        recentUsers,
      });
    } catch (err) {
      console.error("Admin stats error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

/**
 * Admin: Get all registered users directory with optional role & search filtering.
 */
app.get(
  "/users",
  verifyToken,
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { search, role } = req.query;
      const filter = {};

      if (role && role !== "all") {
        if (role === "admin") {
          filter.role = "admin";
        } else {
          filter.accountType = role;
        }
      }

      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { businessName: { $regex: search, $options: "i" } },
        ];
      }

      const users = await userCollection
        .find(filter, { projection: { password: 0 } })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(users);
    } catch (err) {
      console.error("Admin get users error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

/**
 * Admin: Block or unblock a registered user.
 */
const handleBlockUser = async (req, res) => {
  try {
    const rawId = req.params.id;
    const objId = toObjectId(rawId);
    const filter = objId ? { $or: [{ _id: objId }, { _id: rawId }] } : { _id: rawId };

    const targetUser = await userCollection.findOne(filter);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Prevent admin from blocking their own account
    if (targetUser._id.toString() === req.findUser._id.toString()) {
      return res
        .status(400)
        .json({ message: "You cannot block your own admin account" });
    }

    const { isBlocked } = req.body ?? {};
    const blockState = Boolean(isBlocked);

    await userCollection.updateOne(filter, {
      $set: {
        isBlocked: blockState,
        banned: blockState,
        updatedAt: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      userId: rawId,
      isBlocked: blockState,
      message: blockState ? "User has been blocked" : "User has been unblocked",
    });
  } catch (err) {
    console.error("Admin block/unblock error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

app.put("/users/:id/block", verifyToken, verifyUser, verifyAdmin, handleBlockUser);
app.patch("/users/:id/block", verifyToken, verifyUser, verifyAdmin, handleBlockUser);

/**
 * Admin: Get all transactions audit logs.
 * Note: Payment status is determined solely by Stripe events.
 * Admins are not allowed to manually modify payment records.
 */
app.get(
  "/transactions",
  verifyToken,
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const transactions = await transactionCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      const userIds = Array.from(
        new Set(transactions.map((t) => t.userId).filter(Boolean)),
      );
      const objIds = userIds.map(toObjectId).filter(Boolean);

      const queryOr = [];
      if (objIds.length > 0) queryOr.push({ _id: { $in: objIds } });
      if (userIds.length > 0) queryOr.push({ _id: { $in: userIds } });

      let users = [];
      if (queryOr.length > 0) {
        users = await userCollection.find({ $or: queryOr }).toArray();
      }

      const userMap = new Map();
      users.forEach((u) => {
        userMap.set(u._id.toString(), u);
      });

      const enrichedTransactions = transactions.map((t) => {
        const vendor = t.userId ? userMap.get(t.userId.toString()) : null;
        return {
          ...t,
          vendorName: vendor?.name || null,
          vendorBusinessName: vendor?.businessName || null,
          vendorImage: vendor?.image || null,
        };
      });

      res.json(enrichedTransactions);
    } catch (err) {
      console.error("Admin transactions error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

/**
 * Admin-only moderation endpoint — approves (active) or declines a listing so
 * it enters/leaves the public directory. Kept separate from the vendor PUT so
 * only admins can change `status`.
 */
app.put(
  "/services/:id/status",
  verifyToken,
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid service id" });
      }

      const { status } = req.body ?? {};
      if (!MODERABLE_SERVICE_STATUSES.includes(status)) {
        return res
          .status(400)
          .json({ message: "Status must be 'active' or 'declined'" });
      }

      const updated = await serviceCollection.findOneAndUpdate(
        { _id },
        { $set: { status, updatedAt: new Date().toISOString() } },
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
  async (req, res) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid service id" });
      }

      const role = String(
        req.findUser?.role ?? req.findUser?.accountType ?? ""
      ).toLowerCase();
      const isAdmin = role === "admin";
      const isVendor =
        role === "vendor" || req.findUser?.accountType === "vendor";

      if (!isAdmin && !isVendor) {
        return res.status(403).json({
          message: "Forbidden: Only admins and vendors can delete services",
        });
      }

      // If vendor (and not admin), verify ownership of the service
      if (!isAdmin) {
        const service = await serviceCollection.findOne({ _id });
        if (!service) {
          return res.status(404).json({ message: "Service not found" });
        }
        const userIdStr = req.findUser._id ? req.findUser._id.toString() : "";
        if (
          service.vendorId !== userIdStr &&
          service.vendorEmail !== req.findUser.email
        ) {
          return res.status(403).json({
            message: "Forbidden: You can only delete your own services",
          });
        }
      }

      const result = await serviceCollection.deleteOne({ _id });

      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "Service not found" });
      }

      res.json({
        success: true,
        deletedId: req.params.id,
        message: "Service deleted successfully",
      });
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



app.get("/bookings/vendor",verifyToken, verifyUser, verifyVendor, isAuthenticBookingVendor, async (req, res) => {
  try {
    const { vendorId, vendorEmail } = req.query;
    const filter = {};
    if (vendorId && vendorEmail) {
      filter.$or = [{ vendorId }, { vendorEmail }];
    } else if (vendorId) {
      filter.vendorId = vendorId;
    } else if (vendorEmail) {
      filter.vendorEmail = vendorEmail;
    }

    const bookings = await bookingCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(bookings);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * Updates a booking request status (accept or reject).
 * Rules:
 * 1. Only pending requests can be accepted or rejected.
 * 2. Once accepted or rejected, a request cannot be processed again.
 */
const updateBookingStatusHandler = async (req, res) => {
  try {
    const rawId = req.params.id;
    const objId = toObjectId(rawId);
    const filter = objId ? { $or: [{ _id: objId }, { _id: rawId }] } : { _id: rawId };

    const booking = await bookingCollection.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const currentStatus = String(
      booking.bookingStatus ?? booking.status ?? "pending"
    ).toLowerCase();

    // Rule: Only pending requests can be processed. Once accepted or rejected, cannot be processed again.
    if (currentStatus !== "pending") {
      return res.status(400).json({
        message: "Once accepted or rejected, a request cannot be processed again",
      });
    }

    const { status, bookingStatus } = req.body ?? {};
    const inputStatus = String(bookingStatus ?? status ?? "").toLowerCase();

    if (!["accepted", "rejected", "declined"].includes(inputStatus)) {
      return res.status(400).json({
        message: "Status must be 'accepted', 'rejected', or 'declined'",
      });
    }

    // Standardize status: store both bookingStatus and status for compatibility
    const targetStatus = inputStatus === "declined" ? "rejected" : inputStatus;

    await bookingCollection.updateOne(filter, {
      $set: {
        bookingStatus: targetStatus,
        status: targetStatus,
        updatedAt: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      status: targetStatus,
      message: `Booking request has been ${targetStatus}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
};

app.put("/bookings/:id/status",verifyToken, verifyUser,verifyVendor, updateBookingStatusHandler);
app.patch("/bookings/:id/status", verifyToken, verifyUser,verifyVendor, updateBookingStatusHandler);
app.put("/bookings/:id", verifyToken, verifyUser, updateBookingStatusHandler);
app.patch("/bookings/:id", verifyToken, verifyUser, updateBookingStatusHandler);

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
      session.amount_total !== PREMIUM_PRICE_CENTS ||
      session.currency !== "usd"
    ) {
      return res.status(400).json({
        error: "Invalid payment session",
      });
    }

    // 3. Stripe has not confirmed the money yet (e.g. delayed payment method)
    if (session.payment_status !== "paid") {
      return res.status(200).json({
        success: false,
        status: "pending",
        message: "Payment is awaiting confirmation",
      });
    }

    // 4. Rediscover the transaction and activate premium. Stripe already
    // confirmed the payment above, so this also covers a missed webhook.
    const result = await activatePremiumSubscription(session);

    if (!result.found) {
      const reason = result.reason;
      const statusCode =
        reason === "transaction-not-found" || reason === "invalid-payment-id"
          ? 404
          : 400;

      return res.status(statusCode).json({
        error:
          reason === "transaction-not-found"
            ? "Payment transaction not found"
            : "Invalid payment reference",
      });
    }

    if (result.reason === "user-not-found") {
      return res.status(404).json({
        error: "User not found for this payment",
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


export default app;
