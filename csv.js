// -------------------------------------------------------------
// Reading CSV files - moved out of server.js into its own file so
// the one-off database/migrate-csv-to-database.js script can read
// the CSVs in EXACTLY the same way the site always has (quoted
// multi-line recipe instructions and all), without a second copy
// of this code that could drift out of step.
// -------------------------------------------------------------

// -------------------------------------------------------------
// Turns raw CSV text into an array of rows, where each row is
// an array of field values. This reads the WHOLE file as one
// stream of characters (not split into lines first), so a real
// line-break typed inside a quoted field (like pressing Enter
// in the Instructions box) is treated as part of that field's
// text, not as the start of a new row.
// -------------------------------------------------------------
function parseCSVRows(csvText) {
    const rows = [];
    let row = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];

        if (char === '"') {
            if (insideQuotes && csvText[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            row.push(current);
            current = '';
        } else if ((char === '\n' || char === '\r') && !insideQuotes) {
            // Only end the row on a line-break that's OUTSIDE quotes.
            // Windows files use \r\n, so skip a lone \r and act on \n.
            if (char === '\r') continue;
            row.push(current);
            rows.push(row);
            row = [];
            current = '';
        } else {
            current += char;
        }
    }

    // Catch the very last field/row if the file doesn't end with
    // a trailing newline.
    if (current.length > 0 || row.length > 0) {
        row.push(current);
        rows.push(row);
    }

    return rows;
}

// -------------------------------------------------------------
// Turns raw CSV text into an array of objects.
// -------------------------------------------------------------
function parseCSV(csvText) {
    const rows = parseCSVRows(csvText.trim());
    if (rows.length === 0) return [];

    const headers = rows[0];

    return rows.slice(1).map(values => {
        const item = {};
        headers.forEach((header, index) => {
            item[header.trim()] = (values[index] || '').trim();
        });
        return item;
    });
}

module.exports = { parseCSVRows, parseCSV };
