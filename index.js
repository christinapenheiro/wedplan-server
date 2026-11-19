import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const app = express();
const port = 8000;
const client = new MongoClient(process.env.MONGODB_URI);

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
const collection = db.collection("user")
const serviceCollection = db.collection("services")
const bookingCollection = db.collection("bookings")

/** Fields a vendor is allowed to change on an existing listing. */
const UPDATABLE_SERVICE_FIELDS = [
  "title",
  "category",
  "price",
  "description",
  "imageUrls",
  "isAvailable",
]

/** Converts a route id to an ObjectId, returning null when it is malformed. */
function toObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}




app.get("/", (req, res) => {
  res.send("Hello World!");
});



app.post("/services",async (req,res)=>{
 try {
   const data = req.body ?? {};
   const now = new Date().toISOString();

   const result = await serviceCollection.insertOne({
     ...data,
     price: Number(data.price) || 0,
     imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls : [],
     // New listings wait for admin approval and are bookable until toggled off.
     status: "Pending",
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



app.get("/services/:id", async (req, res) => {
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



app.put("/services/:id", async (req, res) => {
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



app.delete("/services/:id", async (req, res) => {
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

app.post("/bookings", async (req, res) => {
  try {
    const data = req.body
    const now = new Date().toISOString();

    const result = await db.collection("bookings").insertOne({
      ...data,
      createdAt: now,
      status: "Pending",
    });

    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/bookings",async(req,res) => {
try {
  const {serviceId,customerId} = req.query;
  const filter = {}
  if(serviceId){
    filter.serviceId = serviceId
  }
  if(customerId){
    filter.customerId = customerId
  }

  // Service-scoped lookups back the "already requested?" panel, which expects one record.
  if (serviceId) {
    const booking = await bookingCollection.findOne(filter)
    return res.json(booking)
  }

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
app.delete("/bookings/:id", async (req, res) => {
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
      booking.bookingStatus ?? booking.status ?? "Pending"
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

app.listen(port, () => {
  console.log(`Server is running on Port ${port}`);
});


