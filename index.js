import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import mongoose from "mongoose";
import CallRecord from "./models/CallRecord.js";
import { getOrCreateWallet } from './utils/wallet.js';

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
    FromState: request.body.FromState,
    FromCountry: request.body.FromCountry
  };
  console.log("[Twilio] Call Details:", callDetails);

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
    const callSessions = new Map();  // Store session data for each caller

    fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
        console.info("[Server] Twilio connected to media stream.");

        // Initialize session data for this connection
        const sessionData = {
            streamSid: null,
            elevenLabsWs: null,
            conversationId: null,
            customParams: null
        };
        callSessions.set(connection, sessionData);

        // Handle messages from Twilio
        connection.on("message", async (message) => {
            try {
                const data = JSON.parse(message);
                const session = callSessions.get(connection);

                switch (data.event) {
                    case "start":
                        session.streamSid = data.start.streamSid;
                        session.customParams = data.start.customParameters;
                        console.log(`[Twilio] Stream started with ID: ${session.streamSid}`);
                        console.log("[Twilio] Custom parameters:", session.customParams);
                        
                        const extraBody = {
                            "caller_id": session.customParams.From,
                        };

                        const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}&` + 
                        new URLSearchParams(extraBody).toString();

                        console.log("[II] Full ElevenLabs WebSocket URL:", wsUrl);

                        // Initialize ElevenLabs WebSocket connection
                        console.log("[II] Attempting to connect to ElevenLabs...");
                        session.elevenLabsWs = new WebSocket(wsUrl);
                        
                        session.elevenLabsWs.on('open', () => {
                            console.log('[II] Connected to ElevenLabs for caller:', session.customParams.From);
                            console.log('extraBody', extraBody);
                        });

                        session.elevenLabsWs.on('message', async (data) => {
                            try {
                                const message = JSON.parse(data);
                                console.log('[ElevenLabs] Message type:', message.type);
                                
                                switch (message.type) {
                                    case "conversation_initiation_metadata":
                                        console.info("[ElevenLabs] Initiation metadata:", JSON.stringify(message, null, 2));
                                        session.conversationId = message.conversation_initiation_metadata_event.conversation_id;
                                        console.log("[ElevenLabs] Extracted conversation ID:", session.conversationId);
                                        
                                        try {
                                            // Create new call record without wallet first
                                            const callRecord = new CallRecord({
                                                phoneNumber: session.customParams.From,
                                                conversationId: session.conversationId,
                                                location: {
                                                    country: session.customParams.FromCountry || '',
                                                    city: session.customParams.FromCity || ''
                                                }
                                            });
                                            await callRecord.save();
                                            console.log("[MongoDB] Created new call record with conversation ID:", session.conversationId);
                                        } catch (error) {
                                            console.error("[MongoDB] Error creating call record:", error);
                                        }
                                        break;
                                    case "text":
                                        console.info("[ElevenLabs] Agent response for caller:", session.customParams.From, message.text);
                                        break;
                                    case "audio":
                                        if (message.audio_event?.audio_base_64) {
                                            console.log("[ElevenLabs] Received audio response for caller:", session.customParams.From);
                                            const audioData = {
                                                event: "media",
                                                streamSid: session.streamSid,
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

                        session.elevenLabsWs.on('close', async () => {
                            console.log('[ElevenLabs] Connection closed for caller:', session.customParams.From);
                            if (!session.conversationId) {
                                console.error('[ElevenLabs] No conversation ID available for transcript fetch');
                                return;
                            }

                            console.log('[ElevenLabs] Waiting 3 seconds before fetching transcript...');
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            
                            try {
                                console.log('[ElevenLabs] Fetching transcript for conversation:', session.conversationId);
                                const response = await fetch(
                                    `https://api.elevenlabs.io/v1/convai/conversations/${session.conversationId}`,
                                    {
                                        headers: {
                                            'xi-api-key': process.env.ELEVENLABS_API_KEY
                                        }
                                    }
                                );

                                if (!response.ok) {
                                    throw new Error(`ElevenLabs API returned ${response.status}: ${await response.text()}`);
                                }

                                const transcriptData = await response.json();
                                console.log('\n[Call Ended] Fetched transcript data for caller:', session.customParams.From);

                                // First find the record by conversationId to get its _id
                                const existingRecord = await CallRecord.findOne({ conversationId: session.conversationId });
                                
                                if (!existingRecord) {
                                    console.error('[MongoDB] Failed to find record for conversation:', session.conversationId);
                                    return;
                                }

                                // Update using the exact _id
                                const result = await CallRecord.findByIdAndUpdate(
                                    existingRecord._id,
                                    { transcript: transcriptData },
                                    { new: true }
                                );

                                if (result) {
                                    console.log('[MongoDB] Successfully saved transcript for caller:', session.customParams.From);
                                    
                                    // Loop through transcript messages to find tool calls
                                    const messages = transcriptData.transcript;
                                    if (messages && Array.isArray(messages)) {
                                        let hasToolCalls = false;
                                        let wallet = null;

                                        messages.forEach((msg, index) => {
                                            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                                                hasToolCalls = true;
                                                msg.tool_calls.forEach(tool => {
                                                    const params = JSON.parse(tool.params_as_json);
                                                    console.log('\n[Tool Call] Details:');
                                                    console.log('Tool Name:', tool.tool_name);
                                                    console.log('Request ID:', tool.request_id);
                                                    console.log('Parameters:');
                                                    console.log('- Name:', params.name);
                                                    console.log('- Ticker:', params.ticker);
                                                    console.log('- Description:', params.description);
                                                    if (params.fid) console.log('- FID:', params.fid);
                                                    console.log('------------------------');

                                                    // Save token deployment parameters to database
                                                    CallRecord.findByIdAndUpdate(
                                                        existingRecord._id,
                                                        {
                                                            'tokenDeployment.name': params.name,
                                                            'tokenDeployment.ticker': params.ticker,
                                                            'tokenDeployment.description': params.description,
                                                            'tokenDeployment.fid': params.fid,
                                                            'tokenDeployment.requestedAt': new Date()
                                                        },
                                                        { new: true }
                                                    ).then(updatedRecord => {
                                                        console.log('[MongoDB] Saved token deployment parameters for conversation:', session.conversationId);
                                                    }).catch(error => {
                                                        console.error('[MongoDB] Error saving token deployment parameters:', error);
                                                    });
                                                });
                                            }
                                        });

                                        // Create wallet only if tool calls were found
                                        if (hasToolCalls) {
                                            try {
                                                wallet = await getOrCreateWallet(session.customParams.From);
                                                console.log("[Wallet] Created/Retrieved wallet for caller:", session.customParams.From);
                                                console.log("[Wallet] Address:", wallet.address);

                                                // Update the record with wallet address
                                                await CallRecord.findByIdAndUpdate(
                                                    existingRecord._id,
                                                    { 
                                                        'tokenDeployment.deployerAddress': wallet.address 
                                                    }
                                                );
                                                console.log("[MongoDB] Updated record with wallet address");
                                            } catch (error) {
                                                console.error("[Wallet] Error managing wallet:", error);
                                            }
                                        }
                                    }
                                } else {
                                    console.error('[MongoDB] Failed to save transcript - record not found for phone:', session.customParams.From);
                                }
                            } catch (error) {
                                console.error('[ElevenLabs] Error handling transcript:', error);
                            }
                        });

                        session.elevenLabsWs.on('error', (error) => {
                            console.error('[ElevenLabs] WebSocket error for caller:', session.customParams.From, error);
                        });
                        break;

                    case "media":
                        if (session.elevenLabsWs?.readyState === WebSocket.OPEN) {
                            const audioMessage = {
                                user_audio_chunk: Buffer.from(
                                    data.media.payload,
                                    "base64"
                                ).toString("base64"),
                            };
                            session.elevenLabsWs.send(JSON.stringify(audioMessage));
                        }
                        break;

                    case "stop":
                        if (session.elevenLabsWs) {
                            session.elevenLabsWs.close();
                        }
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
            const session = callSessions.get(connection);
            if (session?.elevenLabsWs) {
                session.elevenLabsWs.close();
            }
            callSessions.delete(connection);  // Clean up session data
            console.log("[Twilio] Client disconnected, session cleaned up");
        });

        // Handle errors from Twilio WebSocket
        connection.on("error", (error) => {
            const session = callSessions.get(connection);
            console.error("[Twilio] WebSocket error:", error);
            if (session?.elevenLabsWs) {
                session.elevenLabsWs.close();
            }
            callSessions.delete(connection);  // Clean up session data
        });
    });
});

// Endpoint to handle deploy_token webhook from ElevenLabs
fastify.post("/api/deploy-token", async (request, reply) => {
    console.log("[Deploy Token] Received request:", request.body);
    try {
        const { name, ticker, description, fid, conversation_id } = request.body;
        console.log("[Deploy Token] Received parameters:", request.body);
        // Validate required parameters
        reply.code(200);
        return { success: true, message: "Token deployment request received" };
    } catch (error) {
        console.error("[Deploy Token] Error processing request:", error);
        reply.code(500);
        return { success: false, error: error.message };
    }
});
// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
}
console.log(`[Server] Listening on port ${PORT}`);
});
