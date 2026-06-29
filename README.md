# Shop Stock Order App

## What it does

- Saves suppliers with email and phone details.
- Saves stock items with supplier, category, and unit.
- Keeps stock details, supplier details, and order list on separate pages.
- Can be installed on Android from Chrome after it is hosted online.
- Opens offline after the first successful visit.
- Builds a supplier-wise order list from dropdowns.
- Shows a PDF preview and download link for the order list.
- Shares the order PDF through Android's share sheet, so you can choose WhatsApp on mobile.
- Opens an email draft for the selected supplier.
- Exports and imports your saved shop data as JSON.
- Exports stock lists to CSV and Excel-compatible `.xls` files.
- Imports stock lists from CSV and app-exported Excel `.xls` files.

Your data is stored in the browser on this computer. Use **Export Data** as a backup.

## WhatsApp sharing

On Android Chrome, tap **Share PDF** from the Order List page. Choose WhatsApp from the Android share sheet. If the browser does not support sharing files, the app shares the order text instead.

## CSV and Excel format

CSV and Excel stock imports should use these columns:

`Item Name`, `Category`, `Supplier`, `Unit`, `Supplier Email`, `Supplier Phone`

Importing a CSV or Excel file adds any new items to your stock list and updates existing items that match by name (your current stock list, suppliers, and orders are not removed). It keeps or creates suppliers based on the supplier name.

## Android use

Host this folder on a web host such as Netlify, Vercel, or GitHub Pages. Open that hosted link in Android Chrome, then use Chrome menu > **Add to Home screen**.

After installing, open the app once while online so it can save the app files for offline use. Your stock data stays on that Android device unless you use **Export Data** and **Import Data** to move it.
