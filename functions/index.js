/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");


const functions = require("firebase-functions");
//instantiate stripe
const Stripe = require('stripe')(process.env.STRIPE_PRIVATE_KEY);

const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// Initialize Firebase Admin with proper configuration
if (process.env.FUNCTIONS_EMULATOR) {
    // Local development with emulators
    admin.initializeApp();
    console.log('Using Firebase emulators');
} else {
    // Production environment
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_API_KEY);
    console.log('Service Account Project ID:', serviceAccount.project_id);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
        storageBucket: `${serviceAccount.project_id}.appspot.com`
    });
    console.log('Using production Firebase environment');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Export the Express app as a Cloud Function
exports.api = onRequest(app);

// Middleware to verify Firebase ID token
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;

        // If role requirement is specified, check user's role
        if (req.requiredRole) {
            const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
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
            userRecord = await admin.auth().createUser({
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
            const userRef = admin.firestore().collection("users").doc(userRecord.uid);
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
        const orderId = admin.firestore().collection('print-orders').doc().id;
        const queueId = admin.firestore().collection('print-queue').doc().id;

        // Create a new order document
        const orderRef = admin.firestore().collection('print-orders').doc(orderId);

        // Store the order metadata in the users collection {userId}/orders/{orderId}
        const userRef = admin.firestore().collection('users').doc(uid);
        await userRef.collection('orders').doc(orderId).set({
            orderId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            ...orderMetadata
        });

        // Start a Firestore batch for atomicity
        const batch = admin.firestore().batch();

        // Save the order metadata
        batch.set(orderRef, {
            userId: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            cardCount: imagePairs.length,
            ...orderMetadata
        });

        // Save the queue entry - this is what the print service will look for
        const queueRef = admin.firestore().collection('print-queue').doc(queueId);
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
        const bucket = admin.storage().bucket();

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
        const orderRef = admin.firestore().collection('print-orders').doc(orderId);
        await orderRef.set({
            userId: req.user.uid,
            status: 'uploading',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            totalImages: imageIds.length
        });

        // Generate signed URLs for each image
        const bucket = admin.storage().bucket();
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
        let query = admin.firestore().collection('print-queue');

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
        const snapshot = await admin.firestore().collection('print-queue').get();

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

