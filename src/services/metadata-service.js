const fs = require('fs');
const path = require('path');
const readline = require('readline');
const exifr = require('exifr');
require('dotenv').config();

// Function to get address from coordinates using Mapbox API
async function getAddressFromCoordinates(coordinates, filename) {
    if (coordinates === "not found") return "not found";
    
    const apiKey = process.env.MAPBOX_API_KEY;
    if (!apiKey) {
        console.log('⚠️  MAPBOX_API_KEY not found in environment variables');
        console.log('   Please create a .env file with: MAPBOX_API_KEY=your_api_key');
        return "API key not configured";
    }
    
    try {
        const [lat, lng] = coordinates.split(',');
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${apiKey}&types=address,poi,place`;
        
        console.log(`   Coordinates: ${coordinates}`);
        console.log(`   Mapbox URL: ${url}`);
        
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.log(`   ❌ Mapbox API error: ${response.status} ${response.statusText}`);
            return `API error: ${response.status}`;
        }
        
        const data = await response.json();
        console.log(`   Raw Mapbox response:`, JSON.stringify(data, null, 2));
        
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

// Function to get user input
function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// Function to validate directory exists
function validateDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return false;
    }
    const stat = fs.statSync(dirPath);
    return stat.isDirectory();
}

// Function to recursively get all image files (JPEG and HEIC only)
function getAllImageFiles(dir, imageFiles = []) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            getAllImageFiles(fullPath, imageFiles);
        } else {
            const ext = path.extname(file).toLowerCase();
            if (['.heic', '.heif', '.jpeg', '.jpg'].includes(ext)) {
                imageFiles.push(fullPath);
            }
        }
    }
    
    return imageFiles;
}

// Function to convert DMS (degrees, minutes, seconds) to decimal degrees
function dmsToDecimal(degrees, minutes, seconds, direction) {
    let decimal = degrees + minutes / 60 + seconds / 3600;
    if (direction === 'S' || direction === 'W') {
        decimal = decimal * -1;
    }
    return decimal;
}

// Function to extract metadata from an image
async function extractMetadata(imagePath, rootDir) {
    try {
        console.log(`Processing: ${path.basename(imagePath)}`);
        
        // Get relative path from root directory
        const relativePath = path.relative(rootDir, imagePath);
        
        // Extract comprehensive metadata in one pass
        const exifData = await exifr.parse(imagePath, {
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
        
        let timestamp = "not found";
        let coordinates = "not found";
        let address = "not found";

        const metadata = {
            sourceImage: relativePath.replace(/\\/g, '/'),
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
                    lat = dmsToDecimal(latDMS[0], latDMS[1], latDMS[2], latRef);
                    lng = dmsToDecimal(lngDMS[0], lngDMS[1], lngDMS[2], lngRef);
                }
            }
            
            if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
                metadata.coordinates = `${lat},${lng}`;
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
        console.error(`Error processing ${path.basename(imagePath)}:`, error.message);
        
        const relativePath = path.relative(rootDir, imagePath);
        return {
            sourceImage: relativePath.replace(/\\/g, '/'),
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

// Main function
async function processImages(inputDir) {
    try {
        console.log(`Starting to process images in: ${inputDir}\n`);
        
        // Generate output filename based on folder name
        const folderName = path.basename(inputDir);
        const outputFile = path.join(inputDir, `${folderName}.json`);
        
        // Get all image files
        const imageFiles = getAllImageFiles(inputDir);
        console.log(`Found ${imageFiles.length} JPEG/HEIC files\n`);
        
        if (imageFiles.length === 0) {
            console.log('No JPEG or HEIC files found!');
            return;
        }
        
        // Process each image
        const results = [];
        for (let i = 0; i < imageFiles.length; i++) {
            console.log(`[${i + 1}/${imageFiles.length}]`);
            const metadata = await extractMetadata(imageFiles[i], inputDir);
            results.push(metadata);
        }
        
        // Look up addresses for images with coordinates
        console.log(`\n🗺️  Looking up addresses for images with GPS coordinates...`);
        const imagesWithCoords = results.filter(r => r.coordinates !== "not found");
        console.log(`Found ${imagesWithCoords.length} images with coordinates\n`);
        
        if (imagesWithCoords.length === 0) {
            console.log('No images with coordinates to look up addresses for.');
        } else {
            for (let i = 0; i < imagesWithCoords.length; i++) {
                const image = imagesWithCoords[i];
                console.log(`📍 [${i + 1}/${imagesWithCoords.length}] ${path.basename(image.sourceImage)}`);
                
                const address = await getAddressFromCoordinates(image.coordinates, path.basename(image.sourceImage));
                image.address = address;
                
                console.log(`   Final address saved: "${address}"\n`);
                
                // Add small delay to respect API rate limits
                if (i < imagesWithCoords.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        }
        
        // Write results to JSON file
        const jsonOutput = JSON.stringify(results, null, 2);
        fs.writeFileSync(outputFile, jsonOutput);
        
        console.log(`\nProcessing complete! Results saved to: ${outputFile}`);
        console.log(`Total images processed: ${results.length}`);
        
        // Show summary
        const withTimestamp = results.filter(r => r.timestamp !== "not found").length;
        const withCoordinates = results.filter(r => r.coordinates !== "not found").length;
        const withAddresses = results.filter(r => r.address !== "not found" && r.address !== "API key not configured" && r.address !== "Address lookup failed").length;
        const withCamera = results.filter(r => r.camera.make !== "not found" || r.camera.model !== "not found").length;
        const withSettings = results.filter(r => Object.values(r.settings).some(v => v !== "not found")).length;
        const withDimensions = results.filter(r => r.dimensions.width !== "not found" || r.dimensions.height !== "not found").length;
        
        console.log(`\n📊 Summary:`);
        console.log(`  Images with timestamp: ${withTimestamp}/${results.length}`);
        console.log(`  Images with GPS coordinates: ${withCoordinates}/${results.length}`);
        console.log(`  Images with addresses: ${withAddresses}/${results.length}`);
        console.log(`  Images with camera info: ${withCamera}/${results.length}`);
        console.log(`  Images with photo settings: ${withSettings}/${results.length}`);
        console.log(`  Images with dimensions: ${withDimensions}/${results.length}`);
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Main execution
async function main() {
    console.log('Image Metadata Extractor (JPEG/HEIC)');
    console.log('====================================');
    
    let inputDirectory;
    
    while (true) {
        inputDirectory = await askQuestion('Enter the path to the images folder: ');
        
        if (validateDirectory(inputDirectory)) {
            break;
        } else {
            console.log('❌ Directory does not exist. Please try again.\n');
        }
    }
    
    console.log(`✅ Processing folder: ${inputDirectory}\n`);
    
    await processImages(inputDirectory);
}

main().catch(console.error);