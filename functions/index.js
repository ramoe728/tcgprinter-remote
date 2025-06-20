/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import * as functions from "firebase-functions";
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import express from "express";
import cors from "cors";
import dotenv from 'dotenv';
import { Stripe } from 'stripe';
import { defineSecret } from "firebase-functions/params";
import crypto from 'crypto';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Firebase Admin with proper configuration
let adminApp;
let auth;
let db;
let storage;

async function initializeFirebase() {
    try {
        //if /config/serviceAccountKey.json exists, load it into environment variab SERVICE_ACCOUNT
        if (fs.existsSync(path.join(__dirname, 'config', 'serviceAccountKey.json'))) {
            process.env.SERVICE_ACCOUNT = fs.readFileSync(path.join(__dirname, 'config', 'serviceAccountKey.json'), 'utf8');
        }
        let serviceAccount;
        if (process.env.FUNCTIONS_EMULATOR) {
            // Local development - use environment variable
            if (!process.env.SERVICE_ACCOUNT) {
                throw new Error('SERVICE_ACCOUNT environment variable not found. Please check your .env file.');
            }
            serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
            console.log('Using environment variable for development');
        } else {
            // Production - use application default credentials
            console.log('Using application default credentials for production');
            // Initialize without explicit credentials in production
            if (getApps().length === 0) {
                adminApp = initializeApp();
                console.log('Firebase Admin initialized with default credentials');
            } else {
                adminApp = getApps()[0];
                console.log('Firebase Admin already initialized');
            }
            return;
        }

        console.log('Service Account Project ID:', serviceAccount.project_id);
        console.log('Service Account Client Email:', serviceAccount.client_email);

        if (getApps().length === 0) {
            adminApp = initializeApp({
                credential: cert(serviceAccount),
                projectId: serviceAccount.project_id,
                storageBucket: `${serviceAccount.project_id}.appspot.com`
            });
            console.log('Firebase Admin initialized successfully');
        } else {
            adminApp = getApps()[0];
            console.log('Firebase Admin already initialized');
        }
    } catch (error) {
        console.error('Error initializing Firebase Admin:', error);
        throw error; // Re-throw to handle it in the calling code
    }
}

// Initialize Firebase services
try {
    await initializeFirebase();
    auth = getAuth();
    db = getFirestore();
    storage = getStorage();
    console.log('Firebase services initialized successfully');
} catch (error) {
    console.error('Failed to initialize Firebase services:', error);
    // Don't throw here, let the app continue and handle errors at runtime
}

// Create a function to get the secrets client - only when needed
let secretsClient = null;
async function getSecretsClient() {
    if (!secretsClient) {
        secretsClient = new SecretManagerServiceClient();
    }
    return secretsClient;
}

async function getSecret(secretName) {
    const client = await getSecretsClient();
    const [version] = await client.accessSecretVersion({
        name: `projects/tcgprinter-81fb5/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString();
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Stripe - lazy initialization
const stripe_key = defineSecret("STRIPE_P_KEY")
const print_server_api_key = defineSecret("PRINT_SERVER_API_KEY")
let stripe = null;
async function getStripe() {
    if (!stripe) {

        stripe = new Stripe(process.env.STRIPE_P_KEY);
    }
    return stripe;
}

// HMAC Authentication Functions
function signRequest(body, apiKey) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyString = JSON.stringify(body);
    const payload = bodyString + timestamp;
    const signature = crypto
        .createHmac('sha256', apiKey)
        .update(payload)
        .digest('hex');
    
    return { signature, timestamp };
}

function verifySignature(body, signature, timestamp, apiKey) {
    // Check timestamp (reject requests older than 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp);
    
    if (isNaN(requestTime) || Math.abs(now - requestTime) > 300) {
        return false;
    }
    
    // Verify signature
    const bodyString = JSON.stringify(body);
    const payload = bodyString + timestamp;
    const expectedSignature = crypto
        .createHmac('sha256', apiKey)
        .update(payload)
        .digest('hex');
    
    // Use timing-safe comparison
    return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'), 
        Buffer.from(expectedSignature, 'hex')
    );
}

// Add a test endpoint to verify configuration
app.get("/test-config", async (req, res) => {
    console.log('Test config endpoint hit');
    try {
        if (!adminApp) {
            // In production, we should already be initialized with default credentials
            if (!process.env.FUNCTIONS_EMULATOR) {
                adminApp = getApps()[0];
                if (!adminApp) {
                    throw new Error('Firebase Admin not initialized in production');
                }
            } else {
                // Only try to initialize with service account in emulator
                const serviceAccount = await getSecret('SERVICE_ACCOUNT');
                adminApp = initializeApp({
                    credential: cert(serviceAccount),
                    projectId: serviceAccount.project_id,
                    storageBucket: `${serviceAccount.project_id}.appspot.com`
                });
            }
        }

        const config = {
            environment: process.env.FUNCTIONS_EMULATOR ? 'Emulator' : 'Production',
            projectId: adminApp.options.projectId,
            storageBucket: adminApp.options.storageBucket,
            source: process.env.FUNCTIONS_EMULATOR ? 'local-env' : 'default-credentials'
        };
        console.log('Config object created:', config);

        // Test Firestore connection
        try {
            const testDoc = await db.collection('test').doc('config-test').set({
                timestamp: new Date(),
                test: true
            });
            console.log('Firestore test successful');
        } catch (firestoreError) {
            console.error('Firestore test failed:', firestoreError);
            return res.status(500).json({
                error: "Firestore test failed",
                details: firestoreError.message
            });
        }

        res.json({
            message: "Configuration verified successfully",
            config,
            firestoreTest: "Write successful"
        });
    } catch (error) {
        console.error('Test config endpoint error:', error);
        res.status(500).json({
            error: "Configuration verification failed",
            details: error.message,
            stack: error.stack
        });
    }
});



// Middleware to verify Firebase ID token
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken;

        // If role requirement is specified, check user's role
        if (req.requiredRole) {
            const userDoc = await db.collection('users').doc(decodedToken.uid).get();
            const userData = userDoc.data();
            const userRole = userData?.role || 'user'; // Default to 'user' if no role specified

            // Define role hierarchy with numeric values (higher = more privileges)
            const roleHierarchy = {
                'user': 1,
                'staff': 2,
                'admin': 3,
                'founder': 4
            };

            // Check if user's role has sufficient privileges
            if (!roleHierarchy[userRole] || roleHierarchy[userRole] < roleHierarchy[req.requiredRole]) {
                return res.status(403).json({
                    error: "Forbidden",
                    message: `This action requires ${req.requiredRole} role or higher`
                });
            }
        }

        next();
    } catch (error) {
        res.status(403).json({ error: "Invalid token" });
    }
};

// Middleware to require a specific role
const requireRole = (role) => {
    return (req, res, next) => {
        req.requiredRole = role;
        next();
    };
};


app.post('/create-payment-intent', authenticate, async (req, res) => {
    const { cardCount } = req.body;
    const { deliveryMethod } = req.body
    const numBoxes = Math.ceil(cardCount / 125);
    const box_packaging_cost = 120
    const packaging_total = numBoxes * box_packaging_cost
    const flat_rate_shipping_cost = 1000
    const shippingPackagingTotal = flat_rate_shipping_cost + packaging_total;

    try {
        const stripeInstance = await getStripe();
        const session = await stripeInstance.checkout.sessions.create({
            payment_method_types: ['card'],
            ui_mode: 'embedded',
            mode: 'payment',
            automatic_tax: { enabled: true },
            line_items: [
                {
                    price: 'price_1RWj7hLWCAaLY4PAKasTCkUO', // this is the price id for a card in stripe
                    quantity: cardCount
                },
                {
                    // Custom combined shipping + packaging 
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Shipping & Packaging',
                        },
                        unit_amount: deliveryMethod == 'shipping' ? shippingPackagingTotal : packaging_total,
                    },
                    quantity: 1,
                },
            ],
            return_url: 'https://tcgprinter.com/success?session_id={CHECKOUT_SESSION_ID} '
        })

        res.send({ clientSecret: session.client_secret });
    } catch (error) {
        console.log(error.message)
        res.status(500).send({ error: error.message });
    }
});

app.post("/signup", async (req, res) => {
    try {
        const { email, password, displayName } = req.body;
        if (!email || !password || !displayName) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        let userRecord;
        try {
            // Create user with Firebase Authentication
            userRecord = await auth.createUser({
                email,
                password,
                displayName
            });
            console.log("User created successfully in Auth:", userRecord.uid);
        } catch (authError) {
            console.error("Auth error:", authError);
            return res.status(500).json({
                error: "Authentication error",
                details: authError.message,
                code: authError.code
            });
        }

        try {
            // Store additional user data in Firestore
            const userRef = db.collection("users").doc(userRecord.uid);
            await userRef.set({
                email,
                displayName,
                createdAt: new Date(),
            });
            console.log("User data written to Firestore successfully");
        } catch (firestoreError) {
            console.error("Firestore error details:", {
                message: firestoreError.message,
                code: firestoreError.code,
                stack: firestoreError.stack,
                projectId: admin.app().options.projectId
            });
            // Even if Firestore fails, we still created the user in Auth
            return res.status(201).json({
                message: "User created but profile data could not be saved",
                uid: userRecord.uid,
                firestoreError: firestoreError.message
            });
        }

        res.status(201).json({ message: "User created successfully", uid: userRecord.uid });
    } catch (error) {
        console.error("Unexpected error:", error);
        res.status(500).json({
            error: "Unexpected error occurred",
            details: error.message,
            code: error.code || "unknown"
        });
    }
});




// Validate token
app.post("/validate-token", authenticate, async (req, res) => {
    res.json({
        message: "Token validated",
        uid: req.user.uid
    });
});

// Add a print job to the queue
app.post("/add-order-to-queue", authenticate, async (req, res) => {
    try {
        const { imagePairs, orderMetadata, uid } = req.body;

        if (!imagePairs || !Array.isArray(imagePairs)) {
            return res.status(400).json({
                error: "Invalid request format",
                details: "Request must include imagePairs"
            });
        }

        console.log(`Processing print order with ${imagePairs.length} image pairs`);
        console.log('Image pairs:', JSON.stringify(imagePairs, null, 2));

        console.log('Image pairs:', imagePairs.length);
        console.log('Image pairs:', imagePairs);

        // Generate IDs for the order and queue entry
        const orderId = db.collection('print-orders').doc().id;

        // Create a new order document
        const orderRef = db.collection('print-orders').doc(orderId);

        console.log('Order metadata:', orderMetadata);
        console.log('orderId:', orderId);
        console.log('orderRef:', orderRef);

        // Store the order metadata in the users collection {userId}/orders/{orderId}
        const userRef = db.collection('users').doc(uid);
        await userRef.collection('orders').doc(orderId).set({
            orderId,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            ...orderMetadata
        });

        // Start a Firestore batch for atomicity
        const batch = db.batch();

        // Separate front and back images into arrays
        const front_images = imagePairs.map(pair => pair[0]);
        const back_images = imagePairs.map(pair => pair[1]);

        // Save the order metadata with image arrays
        batch.set(orderRef, {
            userId: req.user.uid,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            status: 'pending',
            imagePairs: {
                front_images,
                back_images
            },
            ...orderMetadata
        });

        // Commit the batch write
        await batch.commit();
        console.log(`Saved order metadata, queue entry, and ${imagePairs.length} image pairs`);

        // Return success response
        res.status(201).json({
            message: "Print order added successfully",
            orderId,
            imagePairCount: imagePairs.length,
        });

    } catch (error) {
        console.error("Error adding print order to queue:", error);
        if (!res.headersSent) {
            res.status(500).json({
                error: "Failed to add print order to queue",
                details: error.message
            });
        }
    }
});

// Backend endpoint to get upload URLs
// Add-order-to-queue is expected to be called first in order to have an orderId
app.post("/get-upload-urls", authenticate, async (req, res) => {
    try {
        const { imageObjects, orderId } = req.body;
        if (!imageObjects || !Array.isArray(imageObjects) || !orderId) {
            return res.status(400).json({ error: "Invalid request" });
        }

        console.log('Current Firebase App:', adminApp ? {
            projectId: adminApp.options.projectId,
            serviceAccount: adminApp.options.credential ? 'Using service account' : 'Using default credentials'
        } : 'No app initialized');

        // Get the order document to verify it exists
        const orderRef = db.collection('print-orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Order not found" });
        }

        // Update only the status field
        await orderRef.update({
            status: 'uploading'
        });

        // Generate upload URLs for each image
        const bucket = storage.bucket();
        console.log('Storage bucket:', bucket.name);

        // Set CORS configuration on the bucket
        await bucket.setCorsConfiguration([
            {
                origin: ['https://tcgprinter.com', 'https://tcgprinterhosting.web.app'],
                method: ['PUT', 'GET', 'HEAD', 'POST', 'OPTIONS'],
                responseHeader: ['Content-Type', 'Access-Control-Allow-Origin', 'Content-Length', 'Content-Range', 'x-goog-content-length-range'],
                maxAgeSeconds: 3600
            }
        ]);

        const uploadUrls = {};

        await Promise.all(imageObjects.map(async (imgObj) => {
            const imageId = imgObj.imageId;
            const imageType = imgObj.imageType || 'png'; // default to png if not provided
            const filePath = `print-images/${orderId}/${imageId}`;
            const file = bucket.file(filePath);
            console.log('Creating upload URL for:', filePath, 'with type:', imageType);

            // Map imageType to MIME type
            let mimeType = 'application/octet-stream';
            if (imageType === 'png') mimeType = 'image/png';
            else if (imageType === 'jpg' || imageType === 'jpeg') mimeType = 'image/jpeg';
            else if (imageType === 'gif') mimeType = 'image/gif';
            // Add more types as needed

            try {
                // Create a reference in Firestore first
                await orderRef.collection('image-refs').doc(imageId).set({
                    storageRef: filePath,
                    uploadStatus: 'pending',
                    createdAt: FieldValue.serverTimestamp(),
                    imageType: imageType
                });

                // Get a signed URL instead of resumable upload
                const [url] = await file.getSignedUrl({
                    version: 'v4',
                    action: 'write',
                    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
                    contentType: mimeType
                });

                console.log('Successfully created upload URL for:', filePath);
                uploadUrls[imageId] = url;
            } catch (error) {
                console.error('Error creating upload URL:', error);
                throw error;
            }
        }));

        res.json({
            uploadUrls,
            orderId,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000)
        });
    } catch (error) {
        console.error("Error generating upload URLs:", error);
        res.status(500).json({
            error: error.message,
            details: "Please ensure the Firebase Storage bucket is properly configured and the service account has the necessary permissions."
        });
    }
});


// Send order to print service. Can only be called by a founding user
app.post("/print-order/:orderId", requireRole('founder'), authenticate, async (req, res) => {
    try {
        const { orderId } = req.params;

        // Get order details
        const orderDoc = await db.collection('print-orders').doc(orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Order not found" });
        }

        const orderData = orderDoc.data();
        const { imagePairs } = orderData;

        // Generate signed URLs for all images (24-hour expiry for large jobs)
        const bucket = storage.bucket();
        const downloadUrls = {};
        const imageMetadata = [];

        // Process front and back images
        const allImages = [
            ...imagePairs.front_images.map(id => ({ id, type: 'front' })),
            ...imagePairs.back_images.map(id => ({ id, type: 'back' }))
        ];

        await Promise.all(allImages.map(async (img) => {
            const filePath = `print-images/${orderId}/${img.id}`;
            const file = bucket.file(filePath);

            try {
                // Get file metadata for size info
                const [metadata] = await file.getMetadata();

                // Generate download URL (24 hours for large jobs)
                const [url] = await file.getSignedUrl({
                    version: 'v4',
                    action: 'read',
                    expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
                });

                downloadUrls[img.id] = url;
                imageMetadata.push({
                    imageId: img.id,
                    type: img.type,
                    size: metadata.size,
                    contentType: metadata.contentType
                });
            } catch (error) {
                console.error(`Error processing image ${img.id}:`, error);
                throw error;
            }
        }));

        // Calculate total download size
        const totalSize = imageMetadata.reduce((sum, img) => sum + parseInt(img.size), 0);

        // Prepare order data for print server
        const printOrderData = {
            orderId,
            downloadUrls,
            imageMetadata,
            imagePairs: {
                front_images: imagePairs.front_images,
                back_images: imagePairs.back_images
            },
            totalImages: allImages.length,
            totalSizeBytes: totalSize,
            totalSizeMB: Math.round(totalSize / (1024 * 1024)),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            orderMetadata: {
                cardCount: orderData.cardCount,
                userId: orderData.userId,
                createdAt: orderData.createdAt,
                ...orderData.orderMetadata
            }
        };

        // Store the print order in the print-queue collection
        const queueRef = db.collection('print-queue').doc(orderId);
        await queueRef.set({
            ...printOrderData,
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        });

        // Update the original order status
        await orderDoc.ref.update({
            status: 'queued-for-print',
            printPreparedAt: FieldValue.serverTimestamp(),
            downloadUrls,
            imageMetadata
        });

        // Return success response to frontend
        res.json({
            message: "Print order queued successfully",
            orderId,
            status: "queued-for-print",
            totalImages: allImages.length,
            totalSizeMB: Math.round(totalSize / (1024 * 1024))
        });

    } catch (error) {
        console.error("Error preparing print job:", error);
        res.status(500).json({
            error: "Failed to prepare print job",
            details: error.message
        });
    }
});

// Get all orders with a specific status (founders only)
app.get("/get-all-orders/:orderStatus", requireRole('founder'), authenticate, async (req, res) => {
    try {
        const { orderStatus } = req.params;
        let query = db.collection('print-orders');

        // Filter by status since it's provided in this route
        query = query.where('status', '==', orderStatus);

        // Execute query
        const snapshot = await query.get();

        if (snapshot.empty) {
            return res.status(200).json({
                message: `No orders found with status: ${orderStatus}`,
                orders: []
            });
        }

        // Process results
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({
                id: doc.id,
                ...doc.data(),
                // Convert Firestore timestamps to ISO strings for serialization
                createdAt: doc.data().createdAt ? doc.data().createdAt.toDate().toISOString() : null,
                updatedAt: doc.data().updatedAt ? doc.data().updatedAt.toDate().toISOString() : null,
                completedAt: doc.data().completedAt ? doc.data().completedAt.toDate().toISOString() : null,
                processingStartedAt: doc.data().processingStartedAt ? doc.data().processingStartedAt.toDate().toISOString() : null
            });
        });

        res.status(200).json({
            message: `Found ${orders.length} orders with status: ${orderStatus}`,
            orders
        });
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({
            error: "Failed to fetch orders",
            details: error.message
        });
    }
});

// Get all orders regardless of status (founders only)
app.get("/get-all-orders", requireRole('founder'), authenticate, async (req, res) => {
    try {
        // Query all orders without status filter
        const snapshot = await db.collection('print-orders').get();

        if (snapshot.empty) {
            return res.status(200).json({
                message: "No orders found",
                orders: []
            });
        }

        // Process results
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({
                id: doc.id,
                ...doc.data(),
                // Convert Firestore timestamps to ISO strings for serialization
                createdAt: doc.data().createdAt ? doc.data().createdAt.toDate().toISOString() : null,
                updatedAt: doc.data().updatedAt ? doc.data().updatedAt.toDate().toISOString() : null,
                completedAt: doc.data().completedAt ? doc.data().completedAt.toDate().toISOString() : null,
                processingStartedAt: doc.data().processingStartedAt ? doc.data().processingStartedAt.toDate().toISOString() : null
            });
        });

        res.status(200).json({
            message: `Found ${orders.length} orders`,
            orders
        });
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({
            error: "Failed to fetch orders",
            details: error.message
        });
    }
});

// Update print status endpoint (called by print server)
app.post("/update-print-status/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status, completedAt, error } = req.body;
        
        // Verify HMAC signature
        const signature = req.headers['x-signature'];
        const timestamp = req.headers['x-timestamp'];
        
        if (!signature || !timestamp) {
            console.log('Missing signature or timestamp in print status update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Missing signature or timestamp' 
            });
        }
        
        const apiKey = process.env.PRINT_SERVER_API_KEY;
        if (!verifySignature(req.body, signature, timestamp, apiKey)) {
            console.log('Invalid signature in print status update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid signature' 
            });
        }

        // Update order in print-orders collection
        const orderRef = db.collection('print-orders').doc(orderId);
        const updateData = {
            status: status,
            updatedAt: FieldValue.serverTimestamp()
        };

        if (completedAt) {
            updateData.completedAt = new Date(completedAt);
        }

        if (error) {
            updateData.printError = error;
        }

        await orderRef.update(updateData);

        // Also update the print-queue entry
        const queueQuery = await db.collection('print-queue').where('orderId', '==', orderId).get();
        if (!queueQuery.empty) {
            const queueDoc = queueQuery.docs[0];
            await queueDoc.ref.update(updateData);
        }

        console.log(`Updated order ${orderId} status to ${status}`);

        res.json({
            message: `Order ${orderId} status updated to ${status}`,
            orderId,
            status
        });

    } catch (error) {
        console.error("Error updating print status:", error);
        res.status(500).json({
            error: "Failed to update print status",
            details: error.message
        });
    }
});

// Update order status endpoint (called by frontend client)
app.post("/update-order-status", authenticate, async (req, res) => {
    try {
        const { orderId, status } = req.body;

        if (!orderId || !status) {
            return res.status(400).json({
                error: "Missing required fields",
                details: "orderId and status are required"
            });
        }

        // Define allowed status transitions for security
        const allowedStatuses = [
            'pending',
            'uploading', 
            'ready-to-print',
            'printing',
            'ready-to-print-backs',
            'completed',
            'cancelled',
            'failed'
        ];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                error: "Invalid status",
                details: `Status must be one of: ${allowedStatuses.join(', ')}`
            });
        }

        // Get the order document
        const orderRef = db.collection('print-orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Order not found" });
        }

        const orderData = orderDoc.data();

        // Check if user owns this order or has admin privileges
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const userData = userDoc.data();
        const userRole = userData?.role || 'user';
        const isOwner = orderData.userId === req.user.uid;
        const isAdmin = ['admin', 'founder'].includes(userRole);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only update your own orders"
            });
        }

        // Update the order status
        const updateData = {
            status: status,
            updatedAt: FieldValue.serverTimestamp()
        };

        // Add completion timestamp if status is completed
        if (status === 'completed') {
            updateData.completedAt = FieldValue.serverTimestamp();
        }

        await orderRef.update(updateData);

        // Also update the user's order copy if it exists
        try {
            const userOrderRef = db.collection('users').doc(orderData.userId).collection('orders').doc(orderId);
            const userOrderDoc = await userOrderRef.get();
            if (userOrderDoc.exists) {
                await userOrderRef.update(updateData);
            }
        } catch (userOrderError) {
            console.warn(`Could not update user order copy: ${userOrderError.message}`);
            // Don't fail the main update if user order copy fails
        }

        // Also update print-queue if it exists
        try {
            const queueQuery = await db.collection('print-queue').where('orderId', '==', orderId).get();
            if (!queueQuery.empty) {
                const queueDoc = queueQuery.docs[0];
                await queueDoc.ref.update(updateData);
            }
        } catch (queueError) {
            console.warn(`Could not update print queue: ${queueError.message}`);
            // Don't fail the main update if queue update fails
        }

        console.log(`Order ${orderId} status updated to ${status} by user ${req.user.uid}`);

        res.json({
            message: `Order status updated successfully`,
            orderId,
            status,
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error("Error updating order status:", error);
        res.status(500).json({
            error: "Failed to update order status",
            details: error.message
        });
    }
});

// Update print queue status endpoint (called by RPi print server)
app.post("/update-print-order-status", async (req, res) => {
    try {
        const { orderId, status, completedAt, error: printError, progress } = req.body;
        
        // Verify HMAC signature
        const signature = req.headers['x-signature'];
        const timestamp = req.headers['x-timestamp'];
        
        if (!signature || !timestamp) {
            console.log('Missing signature or timestamp in print status update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Missing signature or timestamp' 
            });
        }
        
        const apiKey = process.env.PRINT_SERVER_API_KEY;
        if (!verifySignature(req.body, signature, timestamp, apiKey)) {
            console.log('Invalid signature in print status update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid signature' 
            });
        }

        if (!orderId || !status) {
            return res.status(400).json({
                error: "Missing required fields",
                details: "orderId and status are required"
            });
        }

        // Define allowed statuses for print server
        const allowedStatuses = [
            'pending',
            'processing',
            'downloading',
            'ready-to-print',
            'printing',
            'ready-to-print-backs',
            'completed',
            'failed'
        ];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                error: "Invalid status",
                details: `Status must be one of: ${allowedStatuses.join(', ')}`
            });
        }

        // Prepare update data
        const updateData = {
            status: status,
            updatedAt: FieldValue.serverTimestamp()
        };

        if (completedAt) {
            updateData.completedAt = new Date(completedAt);
        }

        if (printError) {
            updateData.printError = printError;
        }

        if (progress) {
            updateData.progress = progress;
        }

        // Update print-orders document
        const orderRef = db.collection('print-orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Print order not found" });
        }

        await orderRef.update(updateData);
        console.log(`Updated print-orders ${orderId} status to ${status}`);

        // Also update the user's order copy if it exists
        try {
            const orderData = orderDoc.data();
            const userOrderRef = db.collection('users').doc(orderData.userId).collection('orders').doc(orderId);
            const userOrderDoc = await userOrderRef.get();
            if (userOrderDoc.exists) {
                await userOrderRef.update(updateData);
                console.log(`Updated user order copy ${orderId} status to ${status}`);
            }
        } catch (userOrderError) {
            console.warn(`Could not update user order copy: ${userOrderError.message}`);
            // Don't fail the main update if user order copy fails
        }

        res.json({
            message: `Print order status updated successfully`,
            orderId,
            status,
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error("Error updating print order status:", error);
        res.status(500).json({
            error: "Failed to update print order status",
            details: error.message
        });
    }
});

// Update print queue item endpoint (called by RPi print server)
app.post("/update-print-queue-item", async (req, res) => {
    try {
        const { orderId, updateData } = req.body;
        
        // Verify HMAC signature
        const signature = req.headers['x-signature'];
        const timestamp = req.headers['x-timestamp'];
        
        if (!signature || !timestamp) {
            console.log('Missing signature or timestamp in print queue update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Missing signature or timestamp' 
            });
        }
        
        const apiKey = process.env.PRINT_SERVER_API_KEY;
        if (!verifySignature(req.body, signature, timestamp, apiKey)) {
            console.log('Invalid signature in print queue update');
            return res.status(401).json({ 
                error: 'Unauthorized',
                message: 'Invalid signature' 
            });
        }

        if (!orderId || !updateData || typeof updateData !== 'object') {
            return res.status(400).json({
                error: "Missing required fields",
                details: "orderId and updateData (object) are required"
            });
        }

        // Prevent updating certain protected fields directly
        const protectedFields = ['orderId', 'createdAt'];
        const filteredUpdateData = { ...updateData };
        
        protectedFields.forEach(field => {
            if (filteredUpdateData.hasOwnProperty(field)) {
                delete filteredUpdateData[field];
                console.warn(`Removed protected field '${field}' from update data`);
            }
        });

        // Always add updatedAt timestamp
        filteredUpdateData.updatedAt = FieldValue.serverTimestamp();

        // Convert date strings to Date objects for specific fields
        const dateFields = ['completedAt', 'startedAt', 'processingStartedAt'];
        dateFields.forEach(field => {
            if (filteredUpdateData[field] && typeof filteredUpdateData[field] === 'string') {
                try {
                    filteredUpdateData[field] = new Date(filteredUpdateData[field]);
                } catch (dateError) {
                    console.warn(`Invalid date format for field '${field}': ${filteredUpdateData[field]}`);
                    delete filteredUpdateData[field];
                }
            }
        });

        // Update print-queue document
        const queueRef = db.collection('print-queue').doc(orderId);
        const queueDoc = await queueRef.get();

        if (!queueDoc.exists) {
            return res.status(404).json({ error: "Print queue item not found" });
        }

        await queueRef.update(filteredUpdateData);
        console.log(`Updated print-queue ${orderId} with data:`, JSON.stringify(filteredUpdateData, null, 2));

        res.json({
            message: `Print queue item updated successfully`,
            orderId,
            updatedFields: Object.keys(filteredUpdateData),
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error("Error updating print queue item:", error);
        res.status(500).json({
            error: "Failed to update print queue item",
            details: error.message
        });
    }
});

app.post("/print-backs/:orderId", requireRole('founder'), authenticate, async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!orderId) {
            return res.status(400).json({
                error: "Missing required fields",
                details: "orderId is required"
            });
        }

        // Find the document in print-queue collection
        const queueRef = db.collection('print-queue').doc(orderId);
        const queueDoc = await queueRef.get();

        if (!queueDoc.exists) {
            return res.status(404).json({ 
                error: "Print queue item not found",
                details: `No print queue document found with orderId: ${orderId}`
            });
        }

        // Update the document with backReady field
        const updateData = {
            backReady: true,
            updatedAt: FieldValue.serverTimestamp()
        };

        await queueRef.update(updateData);
        console.log(`Set backReady to true for order ${orderId}`);

        res.json({
            message: "Print backs status updated successfully",
            orderId,
            backReady: true,
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error("Error printing backs:", error);
        res.status(500).json({
            error: "Failed to update print backs status",
            details: error.message
        });
    }
});

export const api = onRequest({ secrets: [stripe_key, print_server_api_key] }, app);

