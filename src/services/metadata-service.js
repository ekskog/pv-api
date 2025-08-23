const ExifReader = require("exifreader");
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
   * Extract only the essential metadata: date and GPS location
   */
  async extractEssentialMetadata(imageBuffer, filename) {
    try {
      const tags = ExifReader.load(imageBuffer, { expanded: false });

      const metadata = {
        dateTaken: this.extractDate(tags),
        gpsCoordinates: null,
        gpsAddress: null,
        hasData: false,
      };

      // Extract GPS and resolve address if coordinates exist
      const coords = this.extractGPS(tags);
      if (coords) {
        metadata.gpsCoordinates = `${coords.lat},${coords.lng}`;
        metadata.gpsAddress = await this.resolveAddress(coords.lat, coords.lng);
        metadata.hasData = true;
      }

      if (metadata.dateTaken) {
        metadata.hasData = true;
      }

      debugMetadata(`[metadata-service.js LINE 45]: Extracted metadata for ${filename}: ${JSON.stringify(metadata)}`);
      return metadata;
    } catch (error) {
      debugMetadata(
        `[metadata-service.js LINE 48]: Failed to extract metadata from ${filename}: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Extract date from EXIF - try the most common tags only
   */
  extractDate(tags) {
    const dateFields = ["DateTimeOriginal", "DateTime", "DateTimeDigitized"];

    for (const field of dateFields) {
      if (tags[field]?.description) {
        try {
          // Convert EXIF date format "2024:07:21 14:02:24" to ISO
          const isoDate = tags[field].description.replace(
            /(\d{4}):(\d{2}):(\d{2})/,
            "$1-$2-$3"
          );
          return new Date(isoDate).toISOString();
        } catch (error) {
          continue; // Try next field
        }
      }
    }
    return null;
  }

  /**
   * Extract GPS coordinates from EXIF
   */
  extractGPS(tags) {
    if (!tags.GPSLatitude || !tags.GPSLongitude) {
      return null;
    }

    try {
      const lat = this.parseCoordinate(
        tags.GPSLatitude,
        tags.GPSLatitudeRef?.description
      );
      const lng = this.parseCoordinate(
        tags.GPSLongitude,
        tags.GPSLongitudeRef?.description
      );

      if (lat !== null && lng !== null) {
        return { lat, lng };
      }
    } catch (error) {
      debugGps(`[metadata-service.js LINE 99]: GPS parsing error: ${error.message}`);
    }

    return null;
  }

  /**
   * Parse individual GPS coordinate
   */
  parseCoordinate(coord, ref) {
    if (!coord.description) return null;

    let decimal;

    if (typeof coord.description === "number") {
      decimal = coord.description;
    } else if (coord.description.includes(",")) {
      // Parse "degrees,minutes,seconds" format
      const parts = coord.description.split(",").map((p) => parseFloat(p));
      if (parts.length === 3) {
        decimal = parts[0] + parts[1] / 60 + parts[2] / 3600;
      } else {
        return null;
      }
    } else {
      decimal = parseFloat(coord.description);
    }

    if (isNaN(decimal)) return null;

    // Apply hemisphere (S/W = negative)
    if (ref && (ref === "S" || ref === "W")) {
      decimal = -decimal;
    }

    return decimal;
  }

  /**
   * Resolve GPS coordinates to address with caching
   */
  async resolveAddress(lat, lng) {
    if (!this.mapboxToken) return null;

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;

    if (this.gpsCache.has(cacheKey)) {
      return this.gpsCache.get(cacheKey);
    }

    try {
      const response = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${this.mapboxToken}&limit=1`,
        { timeout: 5000 }
      );

      if (response.ok) {
        const data = await response.json();
        const address = data.features?.[0]?.place_name || null;
        this.gpsCache.set(cacheKey, address);
        return address;
      }
    } catch (error) {
      debugGps(`[metadata-service.js LINE 162]: Address lookup failed: ${error.message}`);
    }

    return null;
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
        debugMetadata(`[metadata-service.js LINE 195]: Parsed existing metadata successfully.`);

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
        timestamp: metadata.dateTaken ?? "not captured",
        location: metadata.gpsAddress ?? "not captured",
        coordinates: metadata.gpsCoordinates ?? "not captured",
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
      debugMetadata(`[metadata-service.js LINE 228]: Successfully saved metadata. ETag: ${minioResult.etag}`);


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