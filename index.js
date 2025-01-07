import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import mongoose from "mongoose";
import CallRecord from "./models/CallRecord.js";

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
  // Log all Twilio request parameters
  const callDetails = {
    From: request.body.From,
    To: request.body.To,
    CallSid: request.body.CallSid,
    Direction: request.body.Direction,
    FromCity: request.body.FromCity,
    FromState: request.body.FromState,
    FromZip: request.body.FromZip,
    FromCountry: request.body.FromCountry
  };
  console.log("[Twilio] Call Details:", callDetails);

  try {
    // Save call record to database
    const callRecord = new CallRecord({
      phoneNumber: callDetails.From,
      callSid: callDetails.CallSid,
      location: {
        city: callDetails.FromCity,
        state: callDetails.FromState,
        zip: callDetails.FromZip,
        country: callDetails.FromCountry
      }
    });
    await callRecord.save();
    console.log("[MongoDB] Call record saved successfully");
  } catch (error) {
    console.error("[MongoDB] Error saving call record:", error);
  }

  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
        
            <Parameter name="From" value="${callDetails.From}" />
            <Parameter name="FromCity" value="${callDetails.FromCity || ''}" />
            <Parameter name="FromCountry" value="${callDetails.FromCountry || ''}" />
        </Stream>
    </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;
    let elevenLabsWs = null;
    let conversationId = null;

    // Handle messages from Twilio
    connection.on("message", async (message) => {
    try {
        const data = JSON.parse(message);
        switch (data.event) {
        case "start":
            streamSid = data.start.streamSid;
            const customParams = data.start.customParameters;
            console.log(`[Twilio] Stream started with ID: ${streamSid}`);
            console.log("[Twilio] Custom parameters:", customParams);
            const extraBody = {
              "caller_id": customParams.From,
          };
            // Connect to ElevenLabs with caller info
            const userId = encodeURIComponent(customParams.From || '');
            console.log("[II] Using caller number as user_id:", customParams.From);
            // const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}&user_id=${userId}`;
            const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}&` + 
            new URLSearchParams(extraBody).toString()

            console.log("[II] Full ElevenLabs WebSocket URL:", wsUrl);

            // Initialize ElevenLabs WebSocket connection
            console.log("[II] Attempting to connect to ElevenLabs...");
            elevenLabsWs = new WebSocket(wsUrl);
            
            elevenLabsWs.on('open', () => {
                console.log('[II] Connected to ElevenLabs');
                console.log('extraBody', extraBody)
            });

            elevenLabsWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    
                    switch (message.type) {
                        case "conversation_initiation_metadata":
                            console.info("[ElevenLabs] Initiation metadata:", JSON.stringify(message, null, 2));
                            // Store conversation ID for later use
                            conversationId = message.conversation_initiation_metadata_event.conversation_id;
                            break;
                        case "text":
                            console.info("[ElevenLabs] Agent response:", message.text);
                            break;
                        case "audio":
                            if (message.audio_event?.audio_base_64) {
                                console.log("[ElevenLabs] Received audio response");
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
                    }
                } catch (error) {
                    console.error("[ElevenLabs] Error processing message:", error);
                }
            });

            elevenLabsWs.on('error', (error) => {
                console.error('[ElevenLabs] WebSocket error:', error);
            });

            elevenLabsWs.on('close', async () => {
                console.log('[ElevenLabs] Connection closed');
                if (conversationId) {
                    try {
                        const response = await fetch(
                            `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
                            {
                                headers: {
                                    'xi-api-key': process.env.ELEVENLABS_API_KEY
                                }
                            }
                        );
                        const transcript = await response.json();
                        console.log('\n[Call Ended] Conversation Transcript:', transcript);
                    } catch (error) {
                        console.error('[ElevenLabs] Error fetching transcript:', error);
                    }
                }
            });
            break;
        case "media":
            // Route audio from Twilio to ElevenLabs
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
            // data.media.payload is base64 encoded
            const audioMessage = {
                user_audio_chunk: Buffer.from(
                    data.media.payload,
                    "base64"
                ).toString("base64"),
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
