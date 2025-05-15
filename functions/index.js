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
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import express from "express";
import cors from "cors";
import dotenv from 'dotenv';
import { Stripe } from 'stripe';

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

const secretsClient = new SecretManagerServiceClient();

async function getSecret(secretName) {
    const [version] = await secretsClient.accessSecretVersion({
      name: `projects/tcgprinter-81fb5/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString();
  }

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_PRIVATE_KEY);

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

// Export the Express app as a Cloud Function
export const api = onRequest(app);

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
    const unitPrice = 39;
    const packagingCostPerBox = 120;
    const numBoxes = Math.ceil(cardCount / 100);
    const packagingCost = packagingCostPerBox * numBoxes;

    const totalAmount = (unitPrice * cardCount) + packagingCost;

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalAmount,
            currency: 'usd',
        });

        res.send({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
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

        // Generate IDs for the order and queue entry
        const orderId = db.collection('print-orders').doc().id;
        const queueId = db.collection('print-queue').doc().id;

        // Create a new order document
        const orderRef = db.collection('print-orders').doc(orderId);

        // Store the order metadata in the users collection {userId}/orders/{orderId}
        const userRef = db.collection('users').doc(uid);
        await userRef.collection('orders').doc(orderId).set({
            orderId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            ...orderMetadata
        });

        // Start a Firestore batch for atomicity
        const batch = db.batch();

        // Save the order metadata
        batch.set(orderRef, {
            userId: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            ...orderMetadata
        });

        // Save the queue entry - this is what the print service will look for
        const queueRef = db.collection('print-queue').doc(queueId);
        batch.set(queueRef, {
            orderId: orderId,
            userId: req.user.uid,
            status: 'pending',
            cardCount: imagePairs.length,
            priority: orderMetadata?.priority || 5, // Default medium priority
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Save the image pairs in a subcollection (chunking if necessary)
        const CHUNK_SIZE = 400; // Firestore has a limit of 500 operations per batch

        // Calculate number of chunks needed
        const chunks = Math.ceil(imagePairs.length / CHUNK_SIZE);

        for (let i = 0; i < chunks; i++) {
            // Get current chunk of image pairs
            const chunk = imagePairs.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

            // Save this chunk to a subcollection document
            const pairsDocRef = orderRef.collection('image-pairs').doc(`chunk-${i}`);
            batch.set(pairsDocRef, {
                pairs: chunk,
                chunkIndex: i,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Commit the batch write
        await batch.commit();
        console.log(`Saved order metadata, queue entry, and ${imagePairs.length} image pairs in ${chunks} chunks`);

        // Now handle image data - we'll save references in Firestore and actual data in Storage
        // Initialize storage bucket
        const bucket = storage.bucket();

        // Return success early while we continue processing images in the background
        res.status(201).json({
            message: "Print order added to queue successfully",
            orderId,
            queueId,
            queuePosition: 0, // Will be updated by a background process
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
app.post("/get-upload-urls", authenticate, async (req, res) => {
    try {
        const { imageIds, orderId } = req.body;
        if (!imageIds || !Array.isArray(imageIds) || !orderId) {
            return res.status(400).json({ error: "Invalid request" });
        }

        // Create order metadata first
        const orderRef = db.collection('print-orders').doc(orderId);
        await orderRef.set({
            userId: req.user.uid,
            status: 'uploading',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            totalImages: imageIds.length
        });

        // Generate signed URLs for each image
        const bucket = storage.bucket();
        const uploadUrls = {};

        await Promise.all(imageIds.map(async (imageId) => {
            const filePath = `print-images/${orderId}/${imageId}`;
            const file = bucket.file(filePath);

            // Create a signed URL for uploading (valid for 15 minutes)
            const [url] = await file.getSignedUrl({
                version: 'v4',
                action: 'write',
                expires: Date.now() + 15 * 60 * 1000, // 15 minutes
                contentType: 'application/octet-stream',
            });

            // Store reference in Firestore
            await orderRef.collection('image-refs').doc(imageId).set({
                storageRef: filePath,
                uploadStatus: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            uploadUrls[imageId] = url;
        }));

        res.json({
            uploadUrls,
            orderId,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000)
        });
    } catch (error) {
        console.error("Error generating upload URLs:", error);
        res.status(500).json({ error: error.message });
    }
});

// Send order to print service. Can only be called by a founding user
app.post("/print-order/:orderId", requireRole('founder'), authenticate, async (req, res) => {
    console.log("Print order requested");
    res.status(200).json({ message: "Print order requested" });

    // try {
    //     const { orderId } = req.params;

    //     // Get order details
    //     const orderDoc = await admin.firestore().collection('print-orders').doc(orderId).get();

    //     if (!orderDoc.exists) {
    //         return res.status(404).json({ error: "Order not found" });
    //     }

    //     // Get image pairs for the order
    //     const imagePairsSnapshot = await orderDoc.ref.collection('image-pairs').get();
    //     const imagePairs = [];

    //     imagePairsSnapshot.forEach(doc => {
    //         const data = doc.data();
    //         imagePairs.push(...data.pairs);
    //     });

    //     res.status(200).json({
    //         message: "Print order details retrieved successfully",
    //         order: orderDoc.data(),
    //         imagePairs
    //     });
    // } catch (error) {
    //     console.error("Error retrieving print order:", error);
    //     res.status(500).json({
    //         error: "Failed to retrieve print order",
    //         details: error.message
    //     });
    // }
});

// Get all orders with a specific status (founders only)
app.get("/get-all-orders/:orderStatus", requireRole('founder'), authenticate, async (req, res) => {
    try {
        const { orderStatus } = req.params;
        let query = db.collection('print-queue');

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
        const snapshot = await db.collection('print-queue').get();

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

