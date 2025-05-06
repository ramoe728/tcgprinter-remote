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

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// Initialize Firebase Admin with proper configuration for emulators
// No need to specify service account when using emulators
admin.initializeApp();

// // Initialize Firebase Admin with explicit configuration for emulators
// admin.initializeApp({
//     projectId: 'demo-tcgprinter-remote-server', // Use your project ID here or any placeholder
// });

// // Connect to the Firestore emulator if running locally
// if (process.env.FUNCTIONS_EMULATOR) {
//     const firestore = admin.firestore();
//     firestore.settings({
//         host: 'localhost:8089',
//         ssl: false,
//     });
//     console.log('Using Firestore emulator at localhost:8089');
// }

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
            console.error("Firestore error:", firestoreError);
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