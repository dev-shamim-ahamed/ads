import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import telegramRoutes from "./routes/telegram.js";

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Telegram route
app.use("/api/telegram", telegramRoutes);

// Health check (optional)
app.get("/health", (req, res) => {
  res.json({ status: "OK", message: "Telegram membership backend running" });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
