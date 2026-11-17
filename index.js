import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
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
const collection = db.collection("users")




app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Server is running on Port ${port}`);
});


