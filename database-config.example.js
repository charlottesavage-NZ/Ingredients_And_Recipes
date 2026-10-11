// -------------------------------------------------------------
// EXAMPLE ONLY - the real file is database-config.js (gitignored),
// which only exists on the garage server.
//
// While database-config.js doesn't exist, the site uses the CSV
// files. Once it does, the site uses the Azure SQL database instead
// (see database.js) - so creating it IS the switch, and deleting it
// switches back to the CSVs.
//
// Use the limited pantry_app login here, never the admin login.
// NEVER put the real password in this example file.
// -------------------------------------------------------------
module.exports = {
    server: 'charlotte-inventory2.database.windows.net',
    database: 'pantry',
    user: 'pantry_app',
    password: 'PUT-THE-PANTRY_APP-PASSWORD-HERE'
};
