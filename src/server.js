const path = require('path');

// Change working directory to backend folder so relative paths and configs resolve seamlessly
const backendDir = path.resolve(__dirname, '..', 'backend');
process.chdir(backendDir);

// Require and run backend server
require(path.join(backendDir, 'src', 'server.js'));

