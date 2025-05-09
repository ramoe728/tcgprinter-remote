// Firebase authentication utility for getting ID tokens
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import 'dotenv/config';

// Initialize Firebase with your project configuration
// Replace these values with your actual Firebase project details
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

/**
 * Authenticates a user with email and password, then returns their ID token
 * 
 * @param {string} email - The user's email address
 * @param {string} password - The user's password
 * @returns {Promise<string>} A promise that resolves to the user's ID token
 * @throws {Error} If authentication fails or token can't be retrieved
 */
async function getIdToken(email, password) {
    try {
        // Authenticate the user
        const userCredential = await signInWithEmailAndPassword(auth, email, password);

        // Get the authenticated user
        const user = userCredential.user;
        // console.log("USER", user);
        console.log("uid", user.uid);
        // Get the ID token
        const idToken = await user.getIdToken();

        return idToken;
    } catch (error) {
        // Format the error for better debugging
        console.error('Authentication failed:', {
            code: error.code,
            message: error.message
        });

        // Re-throw the error so the caller can handle it
        throw error;
    }
}

// Properly handle the Promise
getIdToken('ecomelitist@gmail.com', 'abc123')
    .then(token => {
        console.log('ID Token:', token);
    })
    .catch(error => {
        console.error('Error getting token:', error.message);
    });

export default getIdToken;