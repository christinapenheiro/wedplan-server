import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import Stripe from "stripe";

const app = express();
const port = 8000;
const client = new MongoClient(process.env.MONGODB_URI);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


app.use(express.json())
app.use(cors());

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

connectToMongoDB()



const db = client.db("wedplan")
const userCollection = db.collection("user")
const serviceCollection = db.collection("services")
const bookingCollection = db.collection("bookings")
const transactionCollection = db.collection("transaction")
const sessionCollection = db.collection("session")

/** Fields a vendor is allowed to change on an existing listing. */
const UPDATABLE_SERVICE_FIELDS = [
  "title",
  "category",
  "price",
  "description",
  "imageUrls",
  "isAvailable",
]

//middleware


const verifyToken = async (req,res,next) => {
  // Check for the Authorization header
  const authHeader = req.headers.authorization;

  if(!authHeader || !authHeader.startsWith("Bearer ")){
    return res.status(401).json({message: "Unauthorized"})
  }

// Extract the token from the header
  const token = authHeader.split(" ")[1];
  if(!token){
    return res.status(401).json({message: "Unauthorized"})
  }

// Check if the token exists in the user collection
const query = { token };
const user = await sessionCollection.findOne(query);
if(!user){
  return res.status(401).json({message: "Unauthorized"})
}

// Attach the user object to the request for further use
req.user = user

next()
};








/** Converts a route id to an ObjectId, returning null when it is malformed. */
function toObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}




app.get("/", (req, res) => {
  res.send("Hello World!");
});



app.post("/services",verifyToken,async (req,res)=>{
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
});



app.get("/services", async (req, res) => {
  try {
    const { vendorId,status } = req.query;
    const filter = {}
    // const filter = vendorId ? { vendorId: String(vendorId) } : {};
    if (vendorId){
      filter.vendorId = vendorId;
    }
    if (status){
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



app.get("/services/:id",verifyToken, async (req, res) => {
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



app.put("/services/:id",verifyToken, async (req, res) => {
  try {
    const _id = req.params.id;
    if (!_id) {
      return res.status(400).json({ message: "Invalid service id" });
    }

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
      { _id },
      { $set: updates },
      { returnDocument: "after" }
    );

    if (!updated) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});



app.delete("/services/:id",verifyToken, async (req, res) => {
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
});

app.post("/bookings",verifyToken, async (req, res) => {
  try {
    const data = req.body
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
});

app.get("/bookings",verifyToken,async(req,res) => {
try {
  const {serviceId,customerId} = req.query;
  const filter = {}
  if(serviceId){
    filter.serviceId = serviceId
  }
  if(customerId){
    filter.customerId = customerId
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
    .toArray()
  res.json(bookings)
}catch (err){
  console.log(err)
  res.status(500).json({message: "Internal server error"})
}
})




/** Deletes a customer's booking request — only while it is still pending. */
app.delete("/bookings/:id",verifyToken, async (req, res) => {
  try {
    const _id = toObjectId(req.params.id);
    if (!_id) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await bookingCollection.findOne({ _id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const status = String(
      booking.bookingStatus ?? booking.status ?? "pending"
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
});




app.post("/create-checkout-session",verifyToken, async (req, res) => {
  try {
    const payload = req.body ?? {};
    console.log("Create checkout session payload:", payload);

    if (!payload.id && !payload.email) {
      return res.status(400).json({ error: "User ID or email is required" });
    }

    // Lookup user by ObjectId, string _id, or email
    const queryConditions = [];
    const objId = toObjectId(payload.id);
    if (objId) queryConditions.push({ _id: objId });
    if (payload.id) queryConditions.push({ _id: payload.id });
    if (payload.email) queryConditions.push({ email: payload.email });

    const user = await userCollection.findOne({ $or: queryConditions });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = (user._id || payload.id).toString();
    const userEmail = user.email || payload.email;

    // Record transaction in database with status 'unpaid'
    const userStatusInfo = {
      userId,
      userEmail,
      amount: 99,
      plan: "free",
      status: "unpaid",
      createdAt: new Date(),
    };
    const paymentConfirmationResult =
      await transactionCollection.insertOne(userStatusInfo);

    // Ensure client URL has protocol
    let clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
    if (!clientUrl.startsWith("http://") && !clientUrl.startsWith("https://")) {
      clientUrl = `http://${clientUrl}`;
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      success_url: `${clientUrl}/dashboard/vendor/success_payment?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/dashboard/vendor/cancel_payment`,
      customer_email: userEmail,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 99 * 100, // $99.00 in cents
            product_data: {
              name: "WedPlan Premium Vendor Membership",
              description: "Unlimited service listings and verified vendor badge",
            },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        paymentId: paymentConfirmationResult.insertedId.toString(),
        userId,
      },
    });

    console.log("Stripe session created successfully:", session.id);

    // If there's session.id after stripe checking
    if (session && session.id) {
      const ninetyDays = new Date();
      ninetyDays.setDate(ninetyDays.getDate() + 90);

      // 1. Change the collection "transaction" status to paid
      await transactionCollection.updateOne(
        { _id: paymentConfirmationResult.insertedId },
        {
          $set: {
            status: "paid",
            sessionId: session.id,
            paidAt: new Date(),
          },
        }
      );

      // 2. Update user collection subscriptionPlan : "Premium" and add subscriptionExpiresAt : (after 90 days)
      await userCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            subscriptionPlan: "premium",
            subscriptionExpiresAt: ninetyDays,
          },
        }
      );
    }

    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Failed to create checkout session:", err);
    res.status(500).json({
      error: "Internal server error",
      message: err.message || "Failed to create checkout session",
    });
  }
});

/**
 * Verify payment endpoint:
 * Checks session with Stripe after checkout redirect and ensures transaction
 * status is updated to "paid" and user subscription is set to "Premium" with 90-day expiry.
 */
app.post("/verify-payment", async (req, res) => {
  try {
    const { sessionId } = req.body ?? {};
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    // Retrieve and check session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session && session.id) {
      const ninetyDays = new Date();
      ninetyDays.setDate(ninetyDays.getDate() + 90);

      const userId = session.metadata?.userId;
      const paymentId = session.metadata?.paymentId;

      // 1. Change the collection "transaction" status to paid
      if (paymentId) {
        const txId = toObjectId(paymentId);
        await transactionCollection.updateOne(
          txId ? { _id: txId } : { _id: paymentId },
          {
            $set: {
              status: "paid",
              sessionId: session.id,
              paidAt: new Date(),
            },
          }
        );
      } else {
        await transactionCollection.updateMany(
          { sessionId: session.id },
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
            },
          }
        );
      }

      // 2. Update user collection subscriptionPlan: "Premium" and subscriptionExpiresAt: (after 90 days)
      if (userId) {
        const userObjId = toObjectId(userId);
        await userCollection.updateOne(
          userObjId ? { _id: userObjId } : { _id: userId },
          {
            $set: {
              subscriptionPlan: "premium",
              subscriptionExpiresAt: ninetyDays,
            },
          }
        );
      }

      return res.json({
        success: true,
        message: "Subscription activated successfully",
        subscriptionPlan: "premium",
        subscriptionExpiresAt: ninetyDays,
      });
    }

    res.status(400).json({ error: "Invalid Stripe session" });
  } catch (err) {
    console.error("Payment verification failed:", err);
    res.status(500).json({
      error: "Internal server error",
      message: err.message || "Failed to verify payment",
    });
  }
});



// app.get("/create-checkout-session",(req,res)=>{
//   res.send({ success: true });
// })








app.listen(port, () => {
  console.log(`Server is running on Port ${port}`);
});


