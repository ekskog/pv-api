const exifr = require("exifr");
const debug = require("debug");

const debugMetadata = debug("photovault:metadata");
const debugGps = debug("photovault:metadata:gps");

/**
 * Optimized Metadata Service - Only extracts date and GPS location
 */
class MetadataService {
  constructor(minioClient, mapboxToken = null) {
    this.minioClient = minioClient;
    this.mapboxToken = mapboxToken || process.env.MAPBOX_TOKEN;
    this.gpsCache = new Map(); // Cache GPS lookups
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
          "DateTimeOriginal",
          "CreateDate",
          "DateTime",
          "DateTimeDigitized",
          // GPS
          "latitude",
          "longitude",
          "GPSLatitude",
          "GPSLongitude",
          "GPSLatitudeRef",
          "GPSLongitudeRef",
          // Camera info
          "Make",
          "Model",
          "Software",
          "LensModel",
          // Photo settings
          "ISO",
          "ISOSpeedRatings",
          "FNumber",
          "ApertureValue",
          "ExposureTime",
          "ShutterSpeedValue",
          "FocalLength",
          "Flash",
          "WhiteBalance",
          // Image properties
          "ImageWidth",
          "ImageHeight",
          "ExifImageWidth",
          "ExifImageHeight",
          "Orientation",
          "ColorSpace",
          "XResolution",
          "YResolution",
        ],
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
          lens: "not found",
        },
        settings: {
          iso: "not found",
          aperture: "not found",
          shutterSpeed: "not found",
          focalLength: "not found",
          flash: "not found",
          whiteBalance: "not found",
        },
        dimensions: {
          width: "not found",
          height: "not found",
          orientation: "not found",
          colorSpace: "not found",
          resolution: {
            x: "not found",
            y: "not found",
          },
        },
      };

      if (exifData) {
        // Extract timestamp
        const dateFields = [
          "DateTimeOriginal",
          "CreateDate",
          "DateTime",
          "DateTimeDigitized",
        ];
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
        else if (
          exifData.GPSLatitude &&
          exifData.GPSLongitude &&
          Array.isArray(exifData.GPSLatitude) &&
          Array.isArray(exifData.GPSLongitude)
        ) {
          const latDMS = exifData.GPSLatitude;
          const lngDMS = exifData.GPSLongitude;
          const latRef = exifData.GPSLatitudeRef || "N";
          const lngRef = exifData.GPSLongitudeRef || "E";

          if (latDMS.length >= 3 && lngDMS.length >= 3) {
            lat = this.dmsToDecimal(latDMS[0], latDMS[1], latDMS[2], latRef);
            lng = this.dmsToDecimal(lngDMS[0], lngDMS[1], lngDMS[2], lngRef);
          }
        }

        if (
          lat !== undefined &&
          lng !== undefined &&
          !isNaN(lat) &&
          !isNaN(lng)
        ) {
          metadata.coordinates = `${lat},${lng}`;

          // Get address from coordinates if available
          metadata.address = await this.getAddressFromCoordinates(
            metadata.coordinates,
            filename
          );
        }

        // Extract camera info
        metadata.camera.make = exifData.Make || "not found";
        metadata.camera.model = exifData.Model || "not found";
        metadata.camera.software = exifData.Software || "not found";
        metadata.camera.lens = exifData.LensModel || "not found";

        // Extract photo settings
        metadata.settings.iso =
          exifData.ISO || exifData.ISOSpeedRatings || "not found";
        metadata.settings.aperture =
          exifData.FNumber || exifData.ApertureValue || "not found";
        metadata.settings.shutterSpeed =
          exifData.ExposureTime || exifData.ShutterSpeedValue || "not found";
        metadata.settings.focalLength = exifData.FocalLength || "not found";
        metadata.settings.flash = exifData.Flash || "not found";
        metadata.settings.whiteBalance = exifData.WhiteBalance || "not found";

        // Extract dimensions
        metadata.dimensions.width =
          exifData.ImageWidth || exifData.ExifImageWidth || "not found";
        metadata.dimensions.height =
          exifData.ImageHeight || exifData.ExifImageHeight || "not found";
        metadata.dimensions.orientation = exifData.Orientation || "not found";
        metadata.dimensions.colorSpace = exifData.ColorSpace || "not found";
        metadata.dimensions.resolution.x = exifData.XResolution || "not found";
        metadata.dimensions.resolution.y = exifData.YResolution || "not found";
      }

      return metadata;
    } catch (error) {
      console.error(
        `Error extracting metadata from ${filename}:`,
        error.message
      );

      return {
        sourceImage: filename,
        timestamp: "not found",
        coordinates: "not found",
        address: "not found",
        camera: {
          make: "not found",
          model: "not found",
          software: "not found",
          lens: "not found",
        },
        settings: {
          iso: "not found",
          aperture: "not found",
          shutterSpeed: "not found",
          focalLength: "not found",
          flash: "not found",
          whiteBalance: "not found",
        },
        dimensions: {
          width: "not found",
          height: "not found",
          orientation: "not found",
          colorSpace: "not found",
          resolution: {
            x: "not found",
            y: "not found",
          },
        },
      };
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
    if (direction === "S" || direction === "W") {
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
      debugGps(
        `[metadata-service.js LINE 211]:  MAPBOX_TOKEN not found in environment variables`
      );
      return "API key not configured";
    }

    try {
      const [lat, lng] = coordinates.split(",");
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${apiKey}&types=address,poi,place`;

      debugGps(
        ` [metadata-service.js LINE 218]:    Coordinates: ${coordinates}`
      );

      //const fetch = (await import('node-fetch')).default;
      //const response = await fetch(url);

      const response = await fetch(url, { timeout: 5000 });

      if (!response.ok) {
        debugGps(
          `  [metadata-service.js LINE 227]: Mapbox API error: ${response.status} ${response.statusText}`
        );
        return `API error: ${response.status}`;
      }

      const data = await response.json();

      if (data.features && data.features.length > 0) {
        const feature = data.features[0];
        const address =
          feature.place_name || feature.text || "Address not found";
        debugGps(
          `  [metadata-service.js LINE 236]:  Found address: ${address}`
        );
        return address;
      } else {
        debugGps(
          `  [metadata-service.js LINE 239]:  No features found in Mapbox response`
        );
        return "Address not found";
      }
    } catch (error) {
      debugGps(
        `  [metadata-service.js LINE 243]: Error getting address for ${coordinates}:`,
        error.message
      );
      return "Address lookup failed";
    }
  }

  /**
   * Update folder metadata JSON with essential data only
   */
  async updateFolderMetadata(bucketName, objectName, metadata) {
    const folderName = objectName.split("/")[0];
    if (!folderName || folderName === objectName) return; // Skip root uploads
    const jsonFileName = `${folderName}/${folderName}.json`;
    debugMetadata(
      `[metadata-service.js LINE 176]: Bucket: ${bucketName}, Folder: ${folderName}, JSON: ${jsonFileName}`
    );

    try {
      let folderData;
      const chunks = [];

      try {
        debugMetadata(
          `[metadata-service.js LINE 186]: Attempting to retrieve existing metadata from ${jsonFileName}...`
        );
        const stream = await this.minioClient.getObject(
          bucketName,
          jsonFileName
        );
        for await (const chunk of stream) chunks.push(chunk);
        const rawData = Buffer.concat(chunks).toString();
        folderData = JSON.parse(rawData);
        debugMetadata(
          `[metadata-service.js LINE 195]: Parsed existing metadata successfully.`
        );
      } catch (err) {
        debugMetadata(
          `Could not retrieve or parse existing metadata. Reason: ${err.message}`
        );
        folderData = {
          folderName,
          media: [],
          lastUpdated: new Date().toISOString(),
        };
      }

      const imageData = {
        sourceImage: objectName,
        timestamp: metadata.timestamp ?? "not captured",
        location: metadata.address ?? "not captured",
        coordinates: metadata.coordinates ?? "not captured",
        camera: metadata.camera ?? "not found",
        settings: metadata.settings ?? "not found",
        dimensions: metadata.dimensions ?? "not found",
      };

      folderData.media = folderData.media.filter(
        (img) => img.sourceImage !== objectName
      );
      folderData.media.push(imageData);
      folderData.lastUpdated = new Date().toISOString();

      const jsonContent = Buffer.from(JSON.stringify(folderData, null, 2));
      const minioResult = await this.minioClient.putObject(
        bucketName,
        jsonFileName,
        jsonContent
      );
      debugMetadata(
        `[metadata-service.js LINE 228]: Successfully saved metadata. ETag: ${minioResult.etag}`
      );

      return true;
    } catch (error) {
      debugMetadata(
        `[metadata-service.js LINE 234]: Failed to update folder metadata: ${error.message}`
      );
      return false;
    }
  }
}

module.exports = MetadataService;
