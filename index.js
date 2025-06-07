#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

/**
 * Standalone HEIC to JPEG converter
 * Usage: node index.js <input.heic> [output.jpg]
 */

async function convertHeicToJpeg(inputPath, outputPath) {
  console.log(`🔄 Converting HEIC to JPEG...`)
  console.log(`📁 Input: ${inputPath}`)
  console.log(`📁 Output: ${outputPath}`)
  
  try {
    // Try Sharp first
    console.log('\n1️⃣ Trying Sharp...')
    await convertWithSharp(inputPath, outputPath)
    console.log('✅ Sharp conversion successful!')
    return
  } catch (sharpError) {
    console.log(`❌ Sharp failed: ${sharpError.message}`)
  }
  
  try {
    // Try heic-convert as fallback
    console.log('\n2️⃣ Trying heic-convert...')
    await convertWithHeicConvert(inputPath, outputPath)
    console.log('✅ heic-convert conversion successful!')
    return
  } catch (heicConvertError) {
    console.log(`❌ heic-convert failed: ${heicConvertError.message}`)
  }
  
  try {
    // Try node-libheif as last resort
    console.log('\n3️⃣ Trying node-libheif...')
    await convertWithLibheif(inputPath, outputPath)
    console.log('✅ node-libheif conversion successful!')
    return
  } catch (libheifError) {
    console.log(`❌ node-libheif failed: ${libheifError.message}`)
  }
  
  throw new Error('All conversion methods failed')
}

async function convertWithSharp(inputPath, outputPath) {
  const sharp = require('sharp')
  
  console.log('📊 Sharp format support:')
  console.log('  HEIF:', sharp.format.heif ? '✅' : '❌')
  console.log('  JPEG:', sharp.format.jpeg ? '✅' : '❌')
  
  await sharp(inputPath)
    .jpeg({ quality: 80 })
    .toFile(outputPath)
}

async function convertWithHeicConvert(inputPath, outputPath) {
  // Try heic-convert library
  const convert = require('heic-convert')
  
  const inputBuffer = fs.readFileSync(inputPath)
  const outputBuffer = await convert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.8
  })
  
  fs.writeFileSync(outputPath, outputBuffer)
}

async function convertWithLibheif(inputPath, outputPath) {
  // Try node-libheif library
  const libheif = require('node-libheif')
  
  const inputBuffer = fs.readFileSync(inputPath)
  const decoder = new libheif.HeifDecoder()
  const data = decoder.decode(inputBuffer)
  
  // Convert to JPEG using Sharp
  const sharp = require('sharp')
  await sharp(data[0], {
    raw: {
      width: data.width,
      height: data.height,
      channels: 4
    }
  })
  .jpeg({ quality: 80 })
  .toFile(outputPath)
}

// Command line interface
async function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    console.log(`
🖼️  HEIC to JPEG Converter

Usage: node index.js <input.heic> [output.jpg]

Examples:
  node index.js photo.heic
  node index.js photo.heic converted.jpg
  node index.js /path/to/IMG_1078.HEIC result.jpg

This script will try multiple conversion methods:
1. Sharp (fastest, built-in)
2. heic-convert (pure JS)
3. node-libheif (native bindings)
`)
    process.exit(1)
  }
  
  const inputPath = args[0]
  const outputPath = args[1] || path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + '.jpg'
  )
  
  // Check if input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`)
    process.exit(1)
  }
  
  // Check if input is HEIC
  if (!/\.(heic|heif)$/i.test(inputPath)) {
    console.error(`❌ Input file is not HEIC/HEIF: ${inputPath}`)
    process.exit(1)
  }
  
  try {
    const startTime = Date.now()
    await convertHeicToJpeg(inputPath, outputPath)
    const endTime = Date.now()
    
    const inputStats = fs.statSync(inputPath)
    const outputStats = fs.statSync(outputPath)
    
    console.log(`\n🎉 Conversion completed successfully!`)
    console.log(`⏱️  Time: ${endTime - startTime}ms`)
    console.log(`📊 Input size: ${(inputStats.size / 1024 / 1024).toFixed(2)} MB`)
    console.log(`📊 Output size: ${(outputStats.size / 1024 / 1024).toFixed(2)} MB`)
    console.log(`📊 Compression: ${((1 - outputStats.size / inputStats.size) * 100).toFixed(1)}%`)
    console.log(`📁 Output saved to: ${outputPath}`)
    
  } catch (error) {
    console.error(`\n❌ Conversion failed: ${error.message}`)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error)
}

module.exports = { convertHeicToJpeg }
