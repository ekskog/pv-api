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

      return metadata;
    } catch (error) {
      debugMetadata(
        `LINE 46: Failed to extract metadata from ${filename}: ${error.message}`
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
      debugGps(`GPS parsing error: ${error.message}`);
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
      debugGps(`Address lookup failed: ${error.message}`);
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
    debugMetadata(`Line 172 - updateFolderMetadata ${objectName}`);
    debugMetadata(
      `Line 173 - Bucket: ${bucketName}, Folder: ${folderName}, JSON: ${jsonFileName}`
    );

    try {
      debugMetadata("Starting folder metadata update process...");

      let folderData;
      const chunks = [];

      try {
        debugMetadata(
          `Attempting to retrieve existing metadata from ${jsonFileName}...`
        );
        const stream = await this.minioClient.getObject(
          bucketName,
          jsonFileName
        );
        for await (const chunk of stream) chunks.push(chunk);
        const rawData = Buffer.concat(chunks).toString();
        folderData = JSON.parse(rawData);
        debugMetadata("Parsed existing metadata successfully.");

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
      debugMetadata(`Successfully saved metadata. ETag: ${minioResult.etag}`);


      return true;
    } catch (error) {
      debugMetadata(
        `LINE 220 - Failed to update folder metadata: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Process existing images in batches

  async batchProcessImages(bucketName, prefix = "", batchSize = 3) {
    const objects = [];
    const stream = this.minioClient.listObjects(bucketName, prefix, true);

    // Get only image files
    for await (const obj of stream) {
      const ext = obj.name.split(".").pop().toLowerCase();
      if (["jpg", "jpeg", "png", "tiff", "heic"].includes(ext)) {
        objects.push(obj);
      }
    }

    let processed = 0;
    for (let i = 0; i < objects.length; i += batchSize) {
      const batch = objects.slice(i, i + batchSize);

      for (const obj of batch) {
        try {
          // Download first 64KB for EXIF
          const stream = await this.minioClient.getPartialObject(
            bucketName,
            obj.name,
            0,
            65536
          );
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);

          // Extract metadata
          const metadata = await this.extractEssentialMetadata(
            buffer,
            obj.name
          );

          if (metadata.hasData) {
            await this.updateFolderMetadata(bucketName, obj.name, metadata);
          }

          processed++;
          if (processed % 10 === 0) {
            debugMetadata(`Progress: ${processed}/${objects.length}`);
          }

          // Rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          console.error(`Failed to process ${obj.name}:`, error.message);
        }
      }
    }
  }
       */
}

module.exports = MetadataService;
