// ============================================
// CONVERT ALL IMAGES TO WEBP SCRIPT
// ============================================
// File: scripts/convertAllImagesToWebp.js
// Description: Converts all image formats (PNG, JPG, JPEG) to WebP format and updates database
// ============================================

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const pool = require('../config/db');

const uploadDir = path.join(__dirname, '../public/uploads/menu');

// Supported image formats to convert
const imageExtensions = ['.png', '.jpg', '.jpeg', '.PNG', '.JPG', '.JPEG'];

async function convertAllImagesToWebp() {
	try {
		console.log('Starting image to WebP conversion...\n');

		// Get all files
		const files = await fs.readdir(uploadDir);
		
		// Filter image files (excluding WebP)
		const imageFiles = files.filter(file => {
			const ext = path.extname(file).toLowerCase();
			return (ext === '.png' || ext === '.jpg' || ext === '.jpeg') && !file.toLowerCase().endsWith('.webp');
		});

		if (imageFiles.length === 0) {
			console.log('No image files found to convert.');
			return;
		}

		console.log(`Found ${imageFiles.length} image files to convert.\n`);

		let convertedCount = 0;
		let updatedDbCount = 0;
		let errorCount = 0;

		// Get all menu items from database that reference non-WebP images
		const [menus] = await pool.execute(
			'SELECT IDNo, MENU_IMG FROM menu WHERE MENU_IMG IS NOT NULL AND MENU_IMG NOT LIKE "%.webp"'
		);

		// Create a map of filename to menu IDs for quick lookup
		const menuMap = new Map();
		menus.forEach(menu => {
			const filename = path.basename(menu.MENU_IMG);
			if (!menuMap.has(filename)) {
				menuMap.set(filename, []);
			}
			menuMap.get(filename).push(menu.IDNo);
		});

		// Process each image file
		for (const imageFile of imageFiles) {
			try {
				const imagePath = path.join(uploadDir, imageFile);
				const ext = path.extname(imageFile);
				const webpFile = imageFile.replace(new RegExp(ext + '$', 'i'), '.webp');
				const webpPath = path.join(uploadDir, webpFile);

				// Check if file exists
				try {
					await fs.access(imagePath);
				} catch {
					console.log(`⚠️  File not found: ${imageFile}, skipping...`);
					continue;
				}

				// Check if WebP already exists
				const webpExists = await fs.access(webpPath).then(() => true).catch(() => false);

				if (!webpExists) {
					// Convert image to WebP
					console.log(`Converting: ${imageFile} -> ${webpFile}...`);
					await sharp(imagePath)
						.webp({ quality: 85 })
						.toFile(webpPath);
					convertedCount++;
					console.log(`  ✓ Converted successfully`);
				} else {
					console.log(`⚠️  WebP already exists for ${imageFile}, skipping conversion but will update DB and delete original...`);
				}

				// Update database - check both exact filename and path-based matching
				const menuIds = menuMap.get(imageFile);
				if (menuIds && menuIds.length > 0) {
					const newPath = `/uploads/menu/${webpFile}`;
					for (const menuId of menuIds) {
						await pool.execute(
							'UPDATE menu SET MENU_IMG = ? WHERE IDNo = ? AND (MENU_IMG LIKE ? OR MENU_IMG = ?)',
							[newPath, menuId, `%${imageFile}`, `/uploads/menu/${imageFile}`]
						);
						updatedDbCount++;
					}
					console.log(`  ✓ Updated ${menuIds.length} database record(s) to use WebP`);
				} else {
					// Also check if database has this file referenced with full path
					const [menusWithPath] = await pool.execute(
						'SELECT IDNo FROM menu WHERE MENU_IMG = ? OR MENU_IMG LIKE ?',
						[`/uploads/menu/${imageFile}`, `%${imageFile}`]
					);
					if (menusWithPath.length > 0) {
						const newPath = `/uploads/menu/${webpFile}`;
						for (const menu of menusWithPath) {
							await pool.execute(
								'UPDATE menu SET MENU_IMG = ? WHERE IDNo = ?',
								[newPath, menu.IDNo]
							);
							updatedDbCount++;
						}
						console.log(`  ✓ Updated ${menusWithPath.length} database record(s) to use WebP (found via path search)`);
					}
				}

				// Delete original image file only if WebP exists (either converted or already existed)
				const finalWebpExists = await fs.access(webpPath).then(() => true).catch(() => false);
				if (finalWebpExists) {
					try {
						await fs.unlink(imagePath);
						console.log(`  ✓ Deleted original ${ext.toUpperCase()} file\n`);
					} catch (unlinkError) {
						console.log(`  ⚠️  Could not delete original file: ${unlinkError.message}\n`);
					}
				} else {
					console.log(`  ⚠️  WebP file not found after conversion, keeping original file\n`);
				}

			} catch (error) {
				console.error(`  ✗ Error processing ${imageFile}:`, error.message);
				errorCount++;
			}
		}

		console.log('\n===========================================');
		console.log('Conversion Summary:');
		console.log(`  ✓ Converted: ${convertedCount} files`);
		console.log(`  ✓ Database records updated: ${updatedDbCount}`);
		console.log(`  ✗ Errors: ${errorCount}`);
		console.log('===========================================\n');

	} catch (error) {
		console.error('Fatal error:', error);
		process.exit(1);
	} finally {
		await pool.end();
	}
}

// Run the conversion
convertAllImagesToWebp()
	.then(() => {
		console.log('Conversion completed successfully!');
		process.exit(0);
	})
	.catch((error) => {
		console.error('Conversion failed:', error);
		process.exit(1);
	});

