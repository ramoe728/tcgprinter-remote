// Firebase authentication utility for getting ID tokens
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import fs from 'fs';
import fetch from 'node-fetch';
import { firebaseConfig } from './functions/config/firebase.js';
// Initialize Firebase with your project configuration
// Replace these values with your actual Firebase project details

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

async function getUploadUrl(imageId, orderId, idToken) {
    const response = await fetch(`https://us-central1-tcgprinter-81fb5.cloudfunctions.net/api/get-upload-urls`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ imageIds: [imageId], orderId })
    });

    return response.json();
}

async function uploadImage(file, uploadUrl, idToken) {
    try {
        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': file.length.toString(),
                'x-goog-content-length-range': `0,${file.length}`,
                'Authorization': `Bearer ${idToken}`
            },
            body: file
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }

        return response;
    } catch (error) {
        console.error('Upload error:', error);
        throw error;
    }
}

// const uploadUrl = "https://storage.googleapis.com/upload/storage/v1/b/tcgprinter-81fb5.firebasestorage.app/o?name=print-images%2F0O6GO5lrAgcTGKiTC3JY%2Fcc7d5d55-e657-4cb4-8623-fadb73f7be2a&uploadType=resumable&upload_id=ABgVH88ZgxP3GDZMVl9YneG4pV8ube7un2gFYaB2OAB4pN7aDTgXFc4UlmMg91inG2yYqfBEq7ymNnjtA1IvyzphEZryYuGr9uYFPq6MSG8EQA";
const imageId = "1";
const orderId = "0O6GO5lrAgcTGKiTC3JY";
const idToken = await getIdToken('ryanallenmoe@gmail.com', '');
console.log("ID TOKEN", idToken);
const uploadUrlResponse = await getUploadUrl({"imageId": "1", "imageType": "png"}, orderId, idToken);
const uploadUrl = uploadUrlResponse.uploadUrls[imageId];
console.log("UPLOAD URL", uploadUrl);
const file = fs.readFileSync('/Users/ryan.moe1/Desktop/card_images/swamp-dragon.png');

await uploadImage(file, uploadUrl, idToken);

// Properly handle the Promise
// getIdToken('ryanallenmoe@gmail.com', '')
//     .then(token => {
//         console.log('ID Token:', token);
//     })
//     .catch(error => {
//         console.error('Error getting token:', error.message);
//     });
