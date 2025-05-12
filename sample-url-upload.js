// upload-service.js
import { getAuth } from 'firebase/auth';

class UploadService {
    constructor(apiBaseUrl = 'https://your-api-url.com') {
        this.apiBaseUrl = apiBaseUrl;
    }

    // Get the current authentication token
    async getAuthToken() {
        const auth = getAuth();
        const user = auth.currentUser;
        if (!user) {
            throw new Error('User not authenticated');
        }
        return user.getIdToken();
    }

    // Step 1: Get signed upload URLs from the backend
    async getUploadUrls(imageIds, orderId) {
        const token = await this.getAuthToken();

        const response = await fetch(`${this.apiBaseUrl}/get-upload-urls`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                imageIds,
                orderId
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to get upload URLs: ${errorData.error || response.statusText}`);
        }

        return await response.json();
    }

    // Step 2: Upload a single image using a signed URL
    async uploadImageWithSignedUrl(signedUrl, imageBlob, onProgress) {
        return new Promise((resolve, reject) => {
            // Create an XMLHttpRequest to be able to track progress
            const xhr = new XMLHttpRequest();

            // Setup progress tracking
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable && onProgress) {
                    const percentComplete = (event.loaded / event.total) * 100;
                    onProgress(percentComplete);
                }
            });

            // Handle completion
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve({
                        success: true,
                        status: xhr.status
                    });
                } else {
                    reject(new Error(`Upload failed with status: ${xhr.status}`));
                }
            });

            // Handle errors
            xhr.addEventListener('error', () => {
                reject(new Error('Network error occurred during upload'));
            });

            xhr.addEventListener('abort', () => {
                reject(new Error('Upload was aborted'));
            });

            // Open and send the request
            xhr.open('PUT', signedUrl, true);

            // Set content type based on the image type
            if (imageBlob.type) {
                xhr.setRequestHeader('Content-Type', imageBlob.type);
            }

            xhr.send(imageBlob);
        });
    }

    // Step 3: Upload multiple images with batching and progress tracking
    async uploadImages(images, onImageProgress, onTotalProgress) {
        try {
            // 1. Generate a unique order ID
            const orderId = this.generateOrderId();

            // 2. Create a map of image IDs to file objects
            const imageMap = {};
            const imageIds = [];

            // Process each image and assign an ID
            Object.entries(images).forEach(([key, image]) => {
                const imageId = key;
                imageIds.push(imageId);
                imageMap[imageId] = image;
            });

            // 3. Get upload URLs for all images
            const { uploadUrls } = await this.getUploadUrls(imageIds, orderId);

            // 4. Upload images in batches
            const BATCH_SIZE = 10; // Number of concurrent uploads
            const totalImages = imageIds.length;
            let completedCount = 0;

            // Track upload results
            const results = {};

            // Process in batches to avoid overwhelming the browser
            for (let i = 0; i < imageIds.length; i += BATCH_SIZE) {
                const batchIds = imageIds.slice(i, i + BATCH_SIZE);

                // Create an array of upload promises for this batch
                const uploadPromises = batchIds.map(async (imageId) => {
                    try {
                        // Get the signed URL and image blob
                        const signedUrl = uploadUrls[imageId];
                        const imageBlob = imageMap[imageId];

                        if (!signedUrl) {
                            throw new Error(`No upload URL provided for image: ${imageId}`);
                        }

                        // Upload with progress tracking
                        const result = await this.uploadImageWithSignedUrl(
                            signedUrl,
                            imageBlob,
                            (progress) => {
                                // Report individual image progress
                                if (onImageProgress) {
                                    onImageProgress(imageId, progress);
                                }
                            }
                        );

                        completedCount++;

                        // Report overall progress
                        if (onTotalProgress) {
                            onTotalProgress(completedCount / totalImages * 100);
                        }

                        results[imageId] = { success: true, ...result };
                        return { imageId, success: true };
                    } catch (error) {
                        completedCount++;

                        // Report overall progress even for failures
                        if (onTotalProgress) {
                            onTotalProgress(completedCount / totalImages * 100);
                        }

                        results[imageId] = { success: false, error: error.message };
                        return { imageId, success: false, error: error.message };
                    }
                });

                // Wait for the current batch to complete before starting the next
                await Promise.all(uploadPromises);
            }

            return {
                success: true,
                orderId,
                results,
                totalImages,
                successCount: Object.values(results).filter(r => r.success).length
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Step 4: Complete the order by submitting image pairs
    async completeOrder(orderId, imagePairs, metadata = {}) {
        const token = await this.getAuthToken();

        const response = await fetch(`${this.apiBaseUrl}/complete-order`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                orderId,
                imagePairs,
                uploadComplete: true,
                orderMetadata: metadata
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to complete order: ${errorData.error || response.statusText}`);
        }

        return await response.json();
    }

    // Helper to generate a unique order ID
    generateOrderId() {
        return 'order-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
    }
}

export default new UploadService();