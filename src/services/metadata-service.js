const fs = require('fs');
const path = require('path');
const exifr = require('exifr');
require('dotenv').config();

class MetadataService {
    constructor(minioClient) {
        this.minioClient = minioClient;
    }

    /**
     * Extract essential metadata from image buffer
     * @param {Buffer} buffer - Image buffer
     * @param {string} filename - Original filename
     * @returns {Object} Extracted metadata
     */
    async extractEssentialMetadata(buffer, filename) {
        try {
            console.log(`Extracting metadata from: ${filename}`);
            
            // Extract comprehensive metadata in one pass
            const exifData = await exifr.parse(buffer, {
                gps: true,
                pick: [
                    // Date/time
                    'DateTimeOriginal', 'CreateDate', 'DateTime', 'DateTimeDigitized',
                    // GPS
                    'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 
                    'GPSLatitudeRef', 'GPSLongitudeRef',
                    // Camera info
                    'Make', 'Model', 'Software', 'LensModel',
                    // Photo settings
                    'ISO', 'ISOSpeedRatings', 'FNumber', 'ApertureValue', 
                    'ExposureTime', 'ShutterSpeedValue', 'FocalLength', 'Flash', 'WhiteBalance',
                    // Image properties
                    'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight', 
                    'Orientation', 'ColorSpace', 'XResolution', 'YResolution'
                ]
            });

            const metadata = {
                sourceImage: filename,
                timestamp: "not found",
                coordinates: "not found",
                address: "not found",
                camera: {
                    make: "not found",
                    model: "not found", 
                    software: "not found",
                    lens: "not found"
                },
                settings: {
                    iso: "not found",
                    aperture: "not found",
                    shutterSpeed: "not found",
                    focalLength: "not found",
                    flash: "not found",
                    whiteBalance: "not found"
                },
                dimensions: {
                    width: "not found",
                    height: "not found",
                    orientation: "not found",
                    colorSpace: "not found",
                    resolution: {
                        x: "not found",
                        y: "not found"
                    }
                }
            };
            
            if (exifData) {
                // Extract timestamp
                const dateFields = ['DateTimeOriginal', 'CreateDate', 'DateTime', 'DateTimeDigitized'];
                for (const field of dateFields) {
                    if (exifData[field]) {
                        try {
                            metadata.timestamp = new Date(exifData[field]).toISOString();
                            break;
                        } catch (e) {
                            continue;
                        }
                    }
                }
                
                // Extract GPS coordinates
                let lat, lng;
                
                // Method 1: Direct decimal coordinates
                if (exifData.latitude && exifData.longitude) {
                    lat = exifData.latitude;
                    lng = exifData.longitude;
                }
                // Method 2: DMS format conversion
                else if (exifData.GPSLatitude && exifData.GPSLongitude && 
                         Array.isArray(exifData.GPSLatitude) && Array.isArray(exifData.GPSLongitude)) {
                    
                    const latDMS = exifData.GPSLatitude;
                    const lngDMS = exifData.GPSLongitude;
                    const latRef = exifData.GPSLatitudeRef || 'N';
                    const lngRef = exifData.GPSLongitudeRef || 'E';
                    
                    if (latDMS.length >= 3 && lngDMS.length >= 3) {
                        lat = this.dmsToDecimal(latDMS[0], latDMS[1], latDMS[2], latRef);
                        lng = this.dmsToDecimal(lngDMS[0], lngDMS[1], lngDMS[2], lngRef);
                    }
                }
                
                if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
                    metadata.coordinates = `${lat},${lng}`;
                    
                    // Get address from coordinates if available
                    metadata.address = await this.getAddressFromCoordinates(metadata.coordinates, filename);
                }

                // Extract camera info
                metadata.camera.make = exifData.Make || "not found";
                metadata.camera.model = exifData.Model || "not found";
                metadata.camera.software = exifData.Software || "not found";
                metadata.camera.lens = exifData.LensModel || "not found";

                // Extract photo settings
                metadata.settings.iso = exifData.ISO || exifData.ISOSpeedRatings || "not found";
                metadata.settings.aperture = exifData.FNumber || exifData.ApertureValue || "not found";
                metadata.settings.shutterSpeed = exifData.ExposureTime || exifData.ShutterSpeedValue || "not found";
                metadata.settings.focalLength = exifData.FocalLength || "not found";
                metadata.settings.flash = exifData.Flash || "not found";
                metadata.settings.whiteBalance = exifData.WhiteBalance || "not found";

                // Extract dimensions
                metadata.dimensions.width = exifData.ImageWidth || exifData.ExifImageWidth || "not found";
                metadata.dimensions.height = exifData.ImageHeight || exifData.ExifImageHeight || "not found";
                metadata.dimensions.orientation = exifData.Orientation || "not found";
                metadata.dimensions.colorSpace = exifData.ColorSpace || "not found";
                metadata.dimensions.resolution.x = exifData.XResolution || "not found";
                metadata.dimensions.resolution.y = exifData.YResolution || "not found";
            }
            
            return metadata;
            
        } catch (error) {
            console.error(`Error extracting metadata from ${filename}:`, error.message);
            
            return {
                sourceImage: filename,
                timestamp: "not found",
                coordinates: "not found",
                address: "not found",
                camera: {
                    make: "not found",
                    model: "not found",
                    software: "not found",
                    lens: "not found"
                },
                settings: {
                    iso: "not found",
                    aperture: "not found",
                    shutterSpeed: "not found",
                    focalLength: "not found",
                    flash: "not found",
                    whiteBalance: "not found"
                },
                dimensions: {
                    width: "not found",
                    height: "not found",
                    orientation: "not found",
                    colorSpace: "not found",
                    resolution: {
                        x: "not found",
                        y: "not found"
                    }
                }
            };
        }
    }

    /**
     * Update folder metadata JSON file
     * @param {string} bucketName - MinIO bucket name
     * @param {string} objectName - Object name of the uploaded file
     * @param {Object} metadata - Extracted metadata
     * @param {Object} uploadResult - Upload result object
     */
    async updateFolderMetadata(bucketName, objectName, metadata, uploadResult) {
        try {
            // Extract folder path from object name
            const folderPath = path.dirname(objectName);
            const folderName = path.basename(folderPath);
            const metadataFileName = `${folderName}.json`;
            const metadataObjectName = folderPath === '.' ? metadataFileName : `${folderPath}/${metadataFileName}`;

            let existingMetadata = [];

            // Try to get existing metadata file
            try {
                const stream = await this.minioClient.getObject(bucketName, metadataObjectName);
                const chunks = [];
                
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                
                const jsonData = Buffer.concat(chunks).toString();
                existingMetadata = JSON.parse(jsonData);
            } catch (error) {
                // File doesn't exist yet, start with empty array
                console.log(`Metadata file ${metadataObjectName} doesn't exist, creating new one`);
                existingMetadata = [];
            }

            // Add new metadata entry
            const metadataEntry = {
                ...metadata,
                sourceImage: path.basename(objectName),
                uploadInfo: {
                    objectName: uploadResult.objectName,
                    size: uploadResult.size,
                    mimetype: uploadResult.mimetype,
                    etag: uploadResult.etag,
                    versionId: uploadResult.versionId,
                    uploadDate: new Date().toISOString()
                }
            };

            // Remove any existing entry for the same file and add the new one
            existingMetadata = existingMetadata.filter(item => item.sourceImage !== path.basename(objectName));
            existingMetadata.push(metadataEntry);

            // Upload updated metadata file
            const updatedJsonData = JSON.stringify(existingMetadata, null, 2);
            
            await this.minioClient.putObject(
                bucketName,
                metadataObjectName,
                Buffer.from(updatedJsonData),
                Buffer.byteLength(updatedJsonData),
                {
                    'Content-Type': 'application/json',
                    'X-Amz-Meta-Generated-By': 'metadata-service',
                    'X-Amz-Meta-Updated-Date': new Date().toISOString()
                }
            );

            console.log(`Successfully updated metadata file: ${metadataObjectName}`);

        } catch (error) {
            console.error(`Error updating folder metadata:`, error.message);
            throw error;
        }
    }

    /**
     * Convert DMS (degrees, minutes, seconds) to decimal degrees
     * @param {number} degrees - Degrees
     * @param {number} minutes - Minutes
     * @param {number} seconds - Seconds
     * @param {string} direction - Direction (N, S, E, W)
     * @returns {number} Decimal degrees
     */
    dmsToDecimal(degrees, minutes, seconds, direction) {
        let decimal = degrees + minutes / 60 + seconds / 3600;
        if (direction === 'S' || direction === 'W') {
            decimal = decimal * -1;
        }
        return decimal;
    }

    /**
     * Get address from coordinates using Mapbox API
     * @param {string} coordinates - Coordinates in "lat,lng" format
     * @param {string} filename - Filename for logging
     * @returns {string} Address or error message
     */
    async getAddressFromCoordinates(coordinates, filename) {
        if (coordinates === "not found") return "not found";
        
        const apiKey = process.env.MAPBOX_TOKEN;
        if (!apiKey) {
            console.log('⚠️  MAPBOX_TOKEN not found in environment variables');
            return "API key not configured";
        }
        
        try {
            const [lat, lng] = coordinates.split(',');
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${apiKey}&types=address,poi,place`;
            
            console.log(`   Coordinates: ${coordinates}`);
            
            const fetch = (await import('node-fetch')).default;
            const response = await fetch(url);
            
            if (!response.ok) {
                console.log(`   ❌ Mapbox API error: ${response.status} ${response.statusText}`);
                return `API error: ${response.status}`;
            }
            
            const data = await response.json();
            
            if (data.features && data.features.length > 0) {
                const feature = data.features[0];
                const address = feature.place_name || feature.text || "Address not found";
                console.log(`   ✅ Found address: ${address}`);
                return address;
            } else {
                console.log(`   ❌ No features found in Mapbox response`);
                return "Address not found";
            }
        } catch (error) {
            console.log(`   ❌ Error getting address for ${coordinates}:`, error.message);
            return "Address lookup failed";
        }
    }
}

module.exports = MetadataService;