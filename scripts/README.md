# EXIF Metadata Extraction Script

This Node.js script processes existing images in MinIO to extract EXIF metadata and update object metadata without re-uploading the files.

## Features

- ✅ **Efficient Processing**: Downloads only image headers (first 64KB) to extract EXIF
- ✅ **Batch Processing**: Processes multiple files in parallel with configurable batch size
- ✅ **In-Place Updates**: Updates MinIO metadata without moving or re-uploading files
- ✅ **Smart Filtering**: Only processes image files, skips already processed files
- ✅ **Dry Run Mode**: Test the script without making any changes
- ✅ **Progress Tracking**: Real-time progress updates and final statistics
- ✅ **Error Handling**: Robust error handling with detailed logging

## Prerequisites

1. **Node.js**: Version 16 or higher
2. **MinIO Access**: Valid credentials and network access to your MinIO instance
3. **Environment Variables**: MinIO connection details (can use existing `.env` file)

## Installation

```bash
# Navigate to the scripts directory
cd /Users/lucarv/Repos/PhotoVault/photovault-api/scripts

# Install dependencies
npm install
```

## Environment Setup

The script uses the same environment variables as your PhotoVault API. Ensure these are set:

```bash
# MinIO Configuration
MINIO_ENDPOINT=your-minio-endpoint
MINIO_PORT=9000
MINIO_USE_SSL=true
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key

# Optional: Default bucket name
DEFAULT_BUCKET=photovault
```

## Usage

### Basic Usage

```bash
# Process all images in the default bucket
node extract-exif-metadata.js

# Process specific bucket
node extract-exif-metadata.js --bucket=photos

# Process only files in a specific folder
node extract-exif-metadata.js --bucket=photovault --prefix=2024/summer/
```

### Advanced Options

```bash
# Dry run (see what would be processed without making changes)
node extract-exif-metadata.js --dry-run

# Custom batch size (default: 5)
node extract-exif-metadata.js --batch-size=10

# Combine options
node extract-exif-metadata.js --bucket=photos --prefix=vacation/ --batch-size=3 --dry-run
```

### NPM Scripts

```bash
# Run with default settings
npm run extract

# Dry run mode
npm run extract:dry-run

# Show help
npm run extract:help
```

## Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--bucket=NAME` | MinIO bucket to process | `photovault` or `DEFAULT_BUCKET` env var |
| `--prefix=PATH` | Only process objects with this prefix | _(none)_ |
| `--batch-size=NUM` | Files to process in parallel | `5` |
| `--dry-run` | Show what would be done without changes | `false` |
| `--help` | Show help message | - |

## What It Does

1. **Scans** the specified MinIO bucket for image files
2. **Downloads** only the first 64KB of each image (sufficient for EXIF data)
3. **Extracts** EXIF metadata including:
   - Date taken (DateTimeOriginal, DateTime, DateTimeDigitized)
   - Camera make and model
   - GPS coordinates (if available)
4. **Updates** MinIO object metadata using copy-in-place operation
5. **Preserves** all existing metadata while adding new EXIF fields

## Metadata Fields Added

The script adds these MinIO metadata fields:

- `X-Amz-Meta-Date-Taken`: ISO timestamp when photo was taken
- `X-Amz-Meta-Camera-Make`: Camera manufacturer (e.g., "Apple")
- `X-Amz-Meta-Camera-Model`: Camera model (e.g., "iPhone 15 Pro")
- `X-Amz-Meta-GPS-Coordinates`: GPS coordinates as "lat,lon"
- `X-Amz-Meta-Has-EXIF`: "true" or "false"
- `X-Amz-Meta-EXIF-Processed`: Timestamp when metadata was extracted

## Example Output

```
📸 EXIF Metadata Extraction Script
=====================================
Bucket: photovault
Prefix: 2024/
Batch size: 5
Dry run: false

[SCAN] Scanning bucket 'photovault' with prefix '2024/'...
[SCAN] Found 150 image files

[BATCH] Processing 150 images in 30 batches of 5

[BATCH] Processing batch 1/30 (5 files)
[PROCESS] Processing 2024/IMG_1234.heic...
[EXIF] Extracted from IMG_1234.heic: { dateTaken: '2024-06-15T14:30:22.000Z', camera: 'Apple iPhone 15 Pro', hasGPS: true }
[UPDATE] Successfully updated metadata for 2024/IMG_1234.heic
[PROGRESS] 3% complete (5/150)

...

==================================================
EXIF EXTRACTION COMPLETE
==================================================
Total files found: 150
Files processed: 150
Files updated: 142
Files skipped: 8
Errors: 0
Duration: 45.2s
Rate: 3.3 files/sec
```

## Safety Features

- **Non-destructive**: Never modifies or moves actual image files
- **Skip processed**: Automatically skips files that already have EXIF metadata
- **Dry run mode**: Test the script safely before making changes
- **Error isolation**: One failed file won't stop the entire batch
- **Partial downloads**: Only downloads enough data to extract EXIF

## Troubleshooting

### Common Issues

1. **"Bucket does not exist"**
   - Check the bucket name with `--bucket=correct-name`
   - Verify MinIO credentials and connection

2. **"No image files found"**
   - Check the prefix with `--prefix=folder/`
   - Ensure images exist in the specified location

3. **"Failed to extract EXIF"**
   - Some images don't have EXIF data (normal for screenshots, edited photos)
   - The script will mark these as `Has-EXIF: false`

4. **Memory issues with large images**
   - Reduce batch size with `--batch-size=2`
   - The script only downloads 64KB per image, not full files

### Performance Tips

- **Smaller batches**: Use `--batch-size=3` for slower networks
- **Larger batches**: Use `--batch-size=10` for fast local networks
- **Specific folders**: Use `--prefix=` to process only what you need

## Integration with PhotoVault API

Once the script completes, your PhotoVault API will automatically:

1. **Include metadata** in `/buckets/:bucketName/objects` responses
2. **Sort chronologically** by date taken when implemented
3. **Display camera info** in photo details
4. **Show GPS data** if available

## Next Steps

After running this script:

1. **Update API**: Modify the objects endpoint to include and sort by `dateTaken`
2. **Update Frontend**: Add sorting by date taken in photo grids
3. **Add UI**: Show camera and date information in photo details
4. **Schedule Regular Runs**: Set up automated processing for new uploads
