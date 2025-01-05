import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import mongoose from "mongoose";
import CallRecord from "./models/CallRecord.js";
import twilio from 'twilio';
const { twiml: { VoiceResponse } } = twilio;

// Load environment variables from .env file
dotenv.config();

const { ELEVENLABS_AGENT_ID, MONGODB_URI } = process.env;

// Check for the required environment variables
if (!ELEVENLABS_AGENT_ID) {
  console.error("Missing ELEVENLABS_AGENT_ID in environment variables");
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in environment variables");
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log("[MongoDB] Connected successfully"))
  .catch((err) => console.error("[MongoDB] Connection error:", err));

// Create a Map to store caller numbers by CallSid
const activeCallers = new Map();

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/incoming-call-eleven", async (request, reply) => {
  // Generate simple TwiML response
  const response = new VoiceResponse();
  response.connect().stream({
    url: `wss://${request.headers.host}/media-stream`
  });

  reply.type("text/xml").send(response.toString());
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;

    // Connect to ElevenLabs Conversational AI WebSocket
    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
    );

    // Handle open event for ElevenLabs WebSocket
    elevenLabsWs.on("open", () => {
      console.log("[II] Connected to Conversational AI.");
    });

    // Handle messages from ElevenLabs
    elevenLabsWs.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        handleElevenLabsMessage(message, connection);
      } catch (error) {
        console.error("[II] Error parsing message:", error);
      }
    });

    // Handle errors from ElevenLabs WebSocket
    elevenLabsWs.on("error", (error) => {
      console.error("[II] WebSocket error:", error);
    });

    // Handle close event for ElevenLabs WebSocket
    elevenLabsWs.on("close", () => {
      console.log("[II] Disconnected.");
    });

    // Function to handle messages from ElevenLabs
    const handleElevenLabsMessage = (message, connection) => {
      switch (message.type) {
        case "conversation_initiation_metadata":
          console.info("[II] Received conversation initiation metadata:", message);
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            // Send audio data to Twilio
            const audioData = {
              event: "media",
              streamSid,
              media: {
                payload: message.audio_event.audio_base_64,
              },
            };
            connection.send(JSON.stringify(audioData));
          }
          break;
        case "interruption":
          // Clear Twilio's audio queue
          connection.send(JSON.stringify({ event: "clear", streamSid }));
          break;
        case "ping":
          // Respond to ping events from ElevenLabs
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            elevenLabsWs.send(JSON.stringify(pongResponse));
          }
          break;
      }
    };

    // Handle messages from Twilio
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            // Store Stream SID and Call SID when stream starts
            const { streamSid: newStreamSid, callSid } = data.start;
            streamSid = newStreamSid;
            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            break;
          case "media":
            // Route audio from Twilio to ElevenLabs
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioMessage = {
                type: "user_audio",
                user_audio_chunk: data.media.payload  // Already base64 encoded
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            // Close ElevenLabs WebSocket when Twilio stream stops
            elevenLabsWs.close();
            break;
          default:
            console.log(`[Twilio] Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle close event from Twilio
    connection.on("close", () => {
      elevenLabsWs.close();
      console.log("[Twilio] Client disconnected");
    });

    // Handle errors from Twilio WebSocket
    connection.on("error", (error) => {
      console.error("[Twilio] WebSocket error:", error);
      elevenLabsWs.close();
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
}
console.log(`[Server] Listening on port ${PORT}`);
});
