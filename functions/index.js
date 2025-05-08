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
    const serviceAccount = require('./config/serviceAccountKey.json');
    console.log('Service Account Project ID:', serviceAccount.project_id);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
    });
    console.log('Using production Firebase environment');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Export the Express app as a Cloud Function
exports.api = functions.https.onRequest(app);

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
        next();
    } catch (error) {
        res.status(403).json({ error: "Invalid token" });
    }
};

// Login endpoint (verifies token and returns user info)
app.post("/login", authenticate, async (req, res) => {
    // res.json({
    //     message: "User authenticated",
    //     uid: req.user.uid,
    //     email: req.user.email,
    // });

    try {
        const userDoc = await admin
            .firestore()
            .collection("users")
            .doc(req.user.uid)
            .get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }
        res.json(userDoc.data());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/profile", authenticate, async (req, res) => {
    try {
        const userDoc = await admin
            .firestore()
            .collection("users")
            .doc(req.user.uid)
            .get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }
        res.json(userDoc.data());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to save order data with image pairs and image data
app.post("/save-order", authenticate, async (req, res) => {
    try {
        const { imagePairs, imageData, orderMetadata } = req.body;

        if (!imagePairs || !Array.isArray(imagePairs) || !imageData || typeof imageData !== 'object') {
            return res.status(400).json({
                error: "Invalid request format",
                details: "Request must include imagePairs array and imageData object"
            });
        }

        // Validate that we have the required fields
        console.log(`Processing order with ${imagePairs.length} image pairs and ${Object.keys(imageData).length} images`);

        // Create a new order document with a generated ID
        const orderId = req.body.orderId || admin.firestore().collection('orders').doc().id;

        // Create a reference to the order document
        const orderRef = admin.firestore().collection('orders').doc(orderId);

        // Start a Firestore batch for atomicity
        const batch = admin.firestore().batch();

        // Save the order metadata
        batch.set(orderRef, {
            userId: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            imagePairCount: imagePairs.length,
            imageCount: Object.keys(imageData).length,
            ...orderMetadata
        });

        // Save the image pairs in a subcollection (chunking if necessary)
        const CHUNK_SIZE = 400; // Firestore has a limit of 500 operations per batch

        // Calculate number of chunks needed
        const chunks = Math.ceil(imagePairs.length / CHUNK_SIZE);

        for (let i = 0; i < chunks; i++) {
            // Get current chunk of image pairs
            const chunk = imagePairs.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

            // Save this chunk to a subcollection document
            const pairsDocRef = orderRef.collection('imagePairs').doc(`chunk-${i}`);
            batch.set(pairsDocRef, {
                pairs: chunk,
                chunkIndex: i,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Commit the batch write
        await batch.commit();
        console.log(`Saved order metadata and ${imagePairs.length} image pairs in ${chunks} chunks`);

        // Now handle image data - we'll save references in Firestore and actual data in Storage
        // Initialize storage bucket
        const bucket = admin.storage().bucket();

        // Track which images we need to save to Storage
        const imagesToSave = [];
        const savedImageRefs = {};

        // Process image data (only storing references in Firestore)
        const imagesBatch = admin.firestore().batch();

        // For each image, prepare it for storage
        for (const [imageId, imageData] of Object.entries(req.body.imageData)) {
            // If the imageData is a base64 string or full image data, it needs to go to Storage
            if (typeof imageData === 'string' && imageData.length > 500) {
                // This is likely image data that needs to go to Storage
                imagesToSave.push({
                    id: imageId,
                    data: imageData
                });

                // Store just a reference in Firestore
                const imageRef = orderRef.collection('images').doc(imageId);
                imagesBatch.set(imageRef, {
                    storageRef: `orders/${orderId}/images/${imageId}`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    userId: req.user.uid
                });
            } else {
                // If it's just metadata or small data, we can store directly in Firestore
                const imageRef = orderRef.collection('images').doc(imageId);
                imagesBatch.set(imageRef, {
                    ...imageData,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    userId: req.user.uid
                });
            }
        }

        // Commit the images batch
        await imagesBatch.commit();
        console.log(`Saved ${Object.keys(req.body.imageData).length} image references to Firestore`);

        // Return success early while we continue processing images in the background
        res.status(201).json({
            message: "Order saved successfully",
            orderId,
            imageCount: Object.keys(req.body.imageData).length,
            imagePairCount: imagePairs.length
        });

        // Upload images to Storage in the background (don't wait for completion to respond)
        // This allows the client to get a quick response while we continue processing
        if (imagesToSave.length > 0) {
            console.log(`Starting background upload of ${imagesToSave.length} images to Storage`);

            // Process in series to avoid overwhelming the server
            for (const image of imagesToSave) {
                try {
                    // Determine if it's base64 or some other format
                    let imageBuffer;
                    if (image.data.startsWith('data:image')) {
                        // Handle base64 encoded image
                        const base64Data = image.data.split(',')[1];
                        imageBuffer = Buffer.from(base64Data, 'base64');
                    } else {
                        // Handle other formats as needed
                        imageBuffer = Buffer.from(image.data);
                    }

                    // Create a reference to where the image will be stored
                    const file = bucket.file(`orders/${orderId}/images/${image.id}`);

                    // Upload the image
                    await file.save(imageBuffer, {
                        metadata: {
                            contentType: 'image/jpeg', // Default to JPEG, adjust as needed
                            metadata: {
                                firebaseStorageDownloadTokens: admin.firestore().collection('_').doc().id
                            }
                        }
                    });

                    console.log(`Uploaded image ${image.id} to Storage`);
                } catch (uploadError) {
                    console.error(`Error uploading image ${image.id}:`, uploadError);
                    // We don't throw the error here to allow other images to be processed
                }
            }

            console.log(`Completed background upload of ${imagesToSave.length} images to Storage`);

            // Update the order status to reflect that images are processed
            await orderRef.update({
                status: 'completed',
                imageUploadCompleted: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    } catch (error) {
        console.error("Error saving order:", error);
        // If we already sent a response, we can't send another one
        if (!res.headersSent) {
            res.status(500).json({
                error: "Failed to save order",
                details: error.message
            });
        }
    }
});