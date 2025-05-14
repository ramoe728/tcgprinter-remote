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

const Stripe = require('stripe');
const stripe = Stripe('place private token here');


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

// Validate token
app.post("/validate-token", authenticate, async (req, res) => {
    res.json({
        message: "Token validated",
        uid: req.user.uid
    });
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
            status: 'pending',
            imagePairCount: imagePairs.length,
            estimatedSize: estimatedSizeMB,
            ...orderMetadata
        });

        // Start a Firestore batch for atomicity
        const batch = admin.firestore().batch();

        // Save the order metadata
        batch.set(orderRef, {
            userId: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'queued',
            imagePairCount: imagePairs.length,
            ...orderMetadata
        });

        // Save the queue entry - this is what the print service will look for
        const queueRef = admin.firestore().collection('print-queue').doc(queueId);
        batch.set(queueRef, {
            orderId: orderId,
            userId: req.user.uid,
            status: 'pending',
            priority: orderMetadata?.priority || 5, // Default medium priority
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            position: 0, // Will be updated by a cloud function that manages the queue
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

// Get the status of the print queue
app.get("/print-queue", authenticate, async (req, res) => {
    try {
        // Fetch all queue entries for this user, ordered by creation time
        const queueSnapshot = await admin
            .firestore()
            .collection('print-queue')
            .where('userId', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .get();

        if (queueSnapshot.empty) {
            return res.json({ queue: [] });
        }

        const queueItems = [];
        queueSnapshot.forEach(doc => {
            queueItems.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate() || null
            });
        });

        res.json({ queue: queueItems });
    } catch (error) {
        console.error("Error fetching print queue:", error);
        res.status(500).json({
            error: "Failed to fetch print queue",
            details: error.message
        });
    }
});

// Get details of a specific print order
app.get("/print-order/:orderId", authenticate, async (req, res) => {
    try {
        const orderId = req.params.orderId;

        // Fetch the order document
        const orderDoc = await admin
            .firestore()
            .collection('print-orders')
            .doc(orderId)
            .get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Print order not found" });
        }

        // Check if the user has permission to view this order
        const orderData = orderDoc.data();
        if (orderData.userId !== req.user.uid) {
            return res.status(403).json({ error: "You don't have permission to view this order" });
        }

        // Fetch image pairs (first chunk only for preview)
        const firstChunkDoc = await orderDoc.ref.collection('image-pairs').doc('chunk-0').get();
        const firstImagePairs = firstChunkDoc.exists ? firstChunkDoc.data().pairs : [];

        // Generate signed URLs for the first 10 images if needed
        let previewImages = {};

        if (firstImagePairs.length > 0) {
            const bucket = admin.storage().bucket();
            const previewIds = [...new Set(firstImagePairs.flat())].slice(0, 10);

            for (const imageId of previewIds) {
                try {
                    const file = bucket.file(`print-images/${orderId}/${imageId}`);
                    const [exists] = await file.exists();

                    if (exists) {
                        // Generate a signed URL for this image (valid for 15 minutes)
                        const [url] = await file.getSignedUrl({
                            action: 'read',
                            expires: Date.now() + 15 * 60 * 1000 // 15 minutes
                        });

                        previewImages[imageId] = url;
                    }
                } catch (error) {
                    console.error(`Error generating signed URL for image ${imageId}:`, error);
                }
            }
        }

        res.json({
            order: {
                id: orderDoc.id,
                ...orderData,
                previewPairs: firstImagePairs.slice(0, 10),
                previewImages,
                createdAt: orderData.createdAt?.toDate() || null,
                updatedAt: orderData.updatedAt?.toDate() || null
            }
        });
    } catch (error) {
        console.error("Error fetching print order details:", error);
        res.status(500).json({
            error: "Failed to fetch print order details",
            details: error.message
        });
    }
});

// // Background function to update queue positions and process the queue
// // This runs on a schedule (every minute) to keep the queue updated
// exports.updateQueuePositions = functions.pubsub
//     .schedule('every 1 minutes')
//     .onRun(async (context) => {
//         try {
//             console.log('Running queue position update job');

//             // Get all pending queue items, ordered by priority (high to low) then creation time
//             const queueSnapshot = await admin
//                 .firestore()
//                 .collection('print-queue')
//                 .where('status', 'in', ['pending', 'ready'])
//                 .orderBy('priority', 'desc')  // Higher priority first
//                 .orderBy('createdAt', 'asc')  // Then first come, first served
//                 .get();

//             if (queueSnapshot.empty) {
//                 console.log('Queue is empty, nothing to update');
//                 return null;
//             }

//             // Update positions in a batch
//             const batch = admin.firestore().batch();
//             let position = 1;

//             queueSnapshot.forEach(doc => {
//                 batch.update(doc.ref, { position: position++ });
//             });

//             await batch.commit();
//             console.log(`Updated ${position - 1} queue items with positions`);

//             return null;
//         } catch (error) {
//             console.error('Error updating queue positions:', error);
//             return null;
//         }
//     });

// Endpoint for the print service to get the next job in the queue
app.post("/print-service/next-job", async (req, res) => {
    try {
        // This endpoint should be secured by API key or other means in production
        const apiKey = req.headers['x-api-key'];

        // In production, validate the API key
        if (!apiKey || apiKey !== process.env.PRINT_SERVICE_API_KEY) {
            return res.status(403).json({ error: "Invalid API key" });
        }

        // Get the next job in the queue
        const queueSnapshot = await admin
            .firestore()
            .collection('print-queue')
            .where('status', '==', 'ready')
            .orderBy('priority', 'desc')
            .orderBy('createdAt', 'asc')
            .limit(1)
            .get();

        if (queueSnapshot.empty) {
            return res.json({ message: "No jobs in queue" });
        }

        const queueDoc = queueSnapshot.docs[0];
        const queueData = queueDoc.data();

        // Mark the job as processing
        await queueDoc.ref.update({
            status: 'processing',
            processingStartedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Get the order details
        const orderDoc = await admin
            .firestore()
            .collection('print-orders')
            .doc(queueData.orderId)
            .get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Order not found for queue item" });
        }

        // Update the order status
        await orderDoc.ref.update({
            status: 'printing',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Get all the image pairs
        const pairsSnapshot = await orderDoc.ref.collection('image-pairs').orderBy('chunkIndex').get();
        let allPairs = [];

        pairsSnapshot.forEach(doc => {
            allPairs = allPairs.concat(doc.data().pairs);
        });

        // Get all the image references
        const imageRefsSnapshot = await orderDoc.ref.collection('image-refs').get();
        const imageRefs = {};

        imageRefsSnapshot.forEach(doc => {
            imageRefs[doc.id] = doc.data();
        });

        // Generate signed URLs for all the images
        const bucket = admin.storage().bucket();
        const imageUrls = {};

        // Process in batches to avoid too many concurrent operations
        const uniqueImageIds = [...new Set(allPairs.flat())];
        const urlBatchSize = 50;

        for (let i = 0; i < uniqueImageIds.length; i += urlBatchSize) {
            const batchIds = uniqueImageIds.slice(i, i + urlBatchSize);

            await Promise.all(batchIds.map(async (imageId) => {
                try {
                    if (imageRefs[imageId]?.storageRef) {
                        const file = bucket.file(`print-images/${queueData.orderId}/${imageId}`);
                        const [exists] = await file.exists();

                        if (exists) {
                            // Generate a signed URL valid for 1 hour
                            const [url] = await file.getSignedUrl({
                                action: 'read',
                                expires: Date.now() + 60 * 60 * 1000 // 1 hour
                            });

                            imageUrls[imageId] = url;
                        }
                    }
                } catch (error) {
                    console.error(`Error generating signed URL for image ${imageId}:`, error);
                }
            }));
        }

        res.json({
            job: {
                queueId: queueDoc.id,
                orderId: queueData.orderId,
                imagePairs: allPairs,
                imageUrls: imageUrls,
                metadata: orderDoc.data()
            }
        });
    } catch (error) {
        console.error("Error getting next print job:", error);
        res.status(500).json({
            error: "Failed to get next print job",
            details: error.message
        });
    }
});

// Endpoint for the print service to mark a job as complete
app.post("/print-service/job-complete", async (req, res) => {
    try {
        // This endpoint should be secured by API key or other means in production
        const apiKey = req.headers['x-api-key'];

        // In production, validate the API key
        if (!apiKey || apiKey !== process.env.PRINT_SERVICE_API_KEY) {
            return res.status(403).json({ error: "Invalid API key" });
        }

        const { queueId, orderId, status, message } = req.body;

        if (!queueId || !orderId) {
            return res.status(400).json({ error: "queueId and orderId are required" });
        }

        // Verify the job exists
        const queueDoc = await admin
            .firestore()
            .collection('print-queue')
            .doc(queueId)
            .get();

        if (!queueDoc.exists) {
            return res.status(404).json({ error: "Queue item not found" });
        }

        const orderDoc = await admin
            .firestore()
            .collection('print-orders')
            .doc(orderId)
            .get();

        if (!orderDoc.exists) {
            return res.status(404).json({ error: "Order not found" });
        }

        // Update queue and order status
        const finalStatus = status === 'failed' ? 'failed' : 'completed';

        await queueDoc.ref.update({
            status: finalStatus,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            message: message || null
        });

        await orderDoc.ref.update({
            status: finalStatus,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            message: message || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ message: "Job marked as " + finalStatus });
    } catch (error) {
        console.error("Error marking job as complete:", error);
        res.status(500).json({
            error: "Failed to mark job as complete",
            details: error.message
        });
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