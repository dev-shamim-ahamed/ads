import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

router.post("/check-membership", async (req, res) => {
  const { userId, channel } = req.body;

  if (!userId || !channel) {
    return res.status(400).json({ success: false, message: "Missing userId or channel" });
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/getChatMember?chat_id=@${channel}&user_id=${userId}`);
    const data = await response.json();

    if (!data.ok) {
      return res.status(400).json({ success: false, message: data.description });
    }

    const status = data.result.status;
    const isMember = ["member", "administrator", "creator"].includes(status);

    res.json({ success: true, isMember, status });
  } catch (error) {
    console.error("Error checking membership:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
