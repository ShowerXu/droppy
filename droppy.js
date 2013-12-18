#!/bin/env node
/* ----------------------------------------------------------------------------
                          droppy - file server on node
                      https://github.com/silverwind/droppy
 ------------------------------------------------------------------------------
 Copyright (c) 2012 - 2013 silverwind

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 --------------------------------------------------------------------------- */
"use strict";

(function () {
    var
        // Libraries
        utils      = require("./lib/utils.js"),
        log        = require("./lib/log.js"),
        // Modules
        archiver   = require("archiver"),
        async      = require("async"),
        ap         = require("autoprefixer"),
        Busboy     = require("busboy"),
        crypto     = require("crypto"),
        fs         = require("graceful-fs"),
        mime       = require("mime"),
        path       = require("path"),
        util       = require("util"),
        Wss        = require("ws").Server,
        wrench     = require("wrench"),
        zlib       = require("zlib"),
        // Variables
        version    = require("./package.json").version,
        configFile = "config.json",
        cache      = {},
        clients    = {},
        db         = {},
        dirs       = {},
        watchers   = {},
        cssCache   = null,
        config     = null,
        firstRun   = null,
        isCLI      = (process.argv.length > 2);
    // Argument handler
    if (isCLI) handleArguments();

    log.simple(log.logo);
    log.simple(log.color.yellow, " ->> ", log.color.blue, "droppy ", log.color.reset,
               log.color.green, version, log.color.reset, " running on ", log.color.blue, "node ", log.color.reset,
               log.color.green, process.version.substring(1), log.color.reset
    );

    parseConfig();
    fs.MAX_OPEN = config.maxOpen;
    log.useTimestamp = config.timestamps;

    // Read user/sessions from DB and check if its the first run
    readDB();
    firstRun = Object.keys(db.users).length < 1;

    // Copy/Minify JS, CSS and HTML content
    prepareContent();

    // Prepare to get up and running
    cacheResources(config.resDir, function () {
        setupDirectories();
        cleanupLinks();
        createListener();
    });

    //-----------------------------------------------------------------------------
    // Read JS/CSS/HTML client resources, minify them, and write them to /res
    function prepareContent() {
        var out = { css : "", js  : "" },
            resources = {
                css  : ["style.css", "sprites.css"],
                js   : ["jquery.js", "client.js"],
                html : ["base.html", "auth.html", "main.html"]
            },
            compiledList = ["base.html", "auth.html", "main.html", "client.js", "style.css"],
            resourceList = utils.flatten(resources),
            matches = { resource: 0, compiled: 0 };

        // Check if we to actually need to recompile resources
        resourceList.forEach(function (file) {
            try {
                if (crypto.createHash("md5").update(fs.readFileSync(getSrcPath(file))).digest("base64") === db.resourceHashes[file])
                    matches.resource++;
                else return;
            } catch (error) { return; }
        });
        compiledList.forEach(function (file) {
            try {
                if (fs.statSync(getResPath(file)))
                    matches.compiled++;
                else return;
            } catch (error) { return; }
        });
        if (matches.resource === resourceList.length &&
            matches.compiled === compiledList.length &&
            db.resourceDebug !== undefined &&
            db.resourceDebug === config.debug) {
            return;
        }

        // Read resources
        for (var type in resources) {
            if (resources.hasOwnProperty(type)) {
                resources[type].forEach(function (file, key, array) {
                    var data;
                    try {
                        data = fs.readFileSync(getSrcPath(file)).toString("utf8");
                    } catch (error) {
                        log.error("Error reading " + file + ":\n", error);
                        process.exit(1);
                    }
                    if (type === "html") {
                        array[key] = {};
                        array[key][file] = data;
                    } else
                        array[key] = data;
                });
            }
        }

        // Concatenate CSS and JS
        log.simple(log.color.yellow, " ->> ", log.color.reset, "minifying resources...");
        resources.css.forEach(function (data) {
            out.css += data + "\n";
        });
        resources.js.forEach(function (data) {
            // Append a semicolon to each javascript file to make sure it's
            // properly terminated. The minifier afterwards will take care of
            // any double-semicolons and whitespace.
            out.js += data + ";\n";
        });

        // Add CSS vendor prefixes
        out.css = ap("last 2 versions").compile(out.css);
        // Minify CSS
        out.css = new require("clean-css")({keepSpecialComments : 0, removeEmpty : true}).minify(out.css);
        // Set the client debug variable to mirror the server's
        out.js = out.js.replace("debug = null;", config.debug ? "debug = true;" : "debug = false;");
        // Minify JS
        !config.debug && (out.js = require("uglify-js").minify(out.js, {
            fromString: true,
            compress: {
                unsafe: true,
                screw_ie8: true
            }
        }).code);

        try {
            resources.html.forEach(function (file) {
                var name = Object.keys(file)[0];
                // Minify HTML by removing tabs, CRs and LFs
                fs.writeFileSync(getResPath(name), file[name].replace(/[\t\r\n]/gm, "").replace("{{version}}", version));
            });
            fs.writeFileSync(getResPath("client.js"), out.js);
            fs.writeFileSync(getResPath("style.css"), out.css);
        } catch (error) {
            log.error("Error writing resources:\n", error);
            process.exit(1);
        }

        // Save the hashes of all compiled files
        resourceList.forEach(function (file) {
            if (!db.resourceHashes) db.resourceHashes = {};
            db.resourceHashes[file] = crypto.createHash("md5").update(fs.readFileSync(getSrcPath(file))).digest("base64");
            db.resourceDebug = config.debug; // Save the state of the last resource compilation
        });
        writeDB();
    }

    //-----------------------------------------------------------------------------
    // Set up the directory
    function setupDirectories() {
        // Clean up the temp dirs
        wrench.rmdirSyncRecursive(config.incomingDir, true);
        wrench.rmdirSyncRecursive(config.zipDir, true);
        try {
            // Create the files and temp dirs
            wrench.mkdirSyncRecursive(config.filesDir, config.dirMode);
            wrench.mkdirSyncRecursive(config.zipDir, config.dirMode);
            wrench.mkdirSyncRecursive(config.incomingDir, config.dirMode);
        } catch (error) {
            log.simple("Unable to create directories:");
            log.error(error);
            process.exit(1);
        }
    }

    //-----------------------------------------------------------------------------
    // Clean up our shortened links by removing links to nonexistant files
    function cleanupLinks() {
        var linkcount = 0, cbcount = 0;
        for (var link in db.shortlinks) {
            if (db.shortlinks.hasOwnProperty(link)) {
                linkcount++;
                (function (shortlink, location) {
                    fs.stat(path.join(config.filesDir, location), function (error, stats) {
                        cbcount++;
                        if (!stats || error) {
                            delete db.shortlinks[shortlink];
                        }
                        if (cbcount === linkcount) {
                            writeDB();
                        }
                    });
                })(link, db.shortlinks[link]);
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Bind to listening port
    function createListener() {
        var server, key, cert;
        if (!config.useHTTPS) {
            server = require("http").createServer(onRequest);
        } else {
            try {
                key = fs.readFileSync(config.httpsKey);
                cert = fs.readFileSync(config.httpsCert);
            } catch (error) {
                log.error("Error reading SSL certificate or key.\n", util.inspect(error));
                process.exit(1);
            }

            // TLS options
            // TODO: Add ECDHE cipers once node supports it (https://github.com/joyent/node/issues/4315)
            // TODO: Use GCM instead of CBC ciphers, once node supports them.
            var options = {
                key              : key,
                cert             : cert,
                honorCipherOrder : true,
                ciphers          : "AES128-GCM-SHA256:!RC4:!MD5:!aNULL:!NULL:!EDH:HIGH",
                secureProtocol   : "SSLv23_server_method"
            };

            if (config.useSPDY) {
                options.windowSize = 1024 * 1024;
                server = require("spdy").createServer(options, onRequest);
            } else {
                server = require("https").createServer(options, onRequest);
            }

            // TLS session resumption
            var sessions = {};

            server.on("newSession", function (id, data) {
                sessions[id] = data;
            });

            server.on("resumeSession", function (id, callback) {
                callback(null, (id in sessions) ? sessions[id] : null);
            });
        }

        server.on("listening", function () {
            setupSocket(server);
            if (config.debug) watchCSS();
            log.simple(log.color.yellow, " ->> ", log.color.reset, "listening on ",
                       log.color.cyan, server.address().address, log.color.reset, ":",
                       log.color.magenta, server.address().port, log.color.reset
            );
        });

        server.on("error", function (error) {
            if (error.code === "EADDRINUSE")
                log.error("Failed to bind to port ", log.color.magenta, port, log.color.reset, ". Address already in use.\n");
            else if (error.code === "EACCES")
                log.error("Failed to bind to port ", log.color.magenta, port, log.color.reset, ". Need permission to bind to ports < 1024.\n");
            else
                log.error("Error:", util.inspect(error));
            process.exit(1);
        });

        var port = (process.env.NODE_ENV === "production") ? process.env.PORT : config.port;
        server.listen(port);
    }

    //-----------------------------------------------------------------------------
    // GET/POST handler
    function onRequest(req, res) {
        switch (req.method.toUpperCase()) {
        case "GET":
            handleGET(req, res);
            break;
        case "POST":
            handlePOST(req, res);
            break;
        case "OPTIONS":
            res.setHeader("Allow", "GET,POST,OPTIONS");
            res.end("\n");
            log.response(req, res);
            break;
        default:
            res.statusCode = 405;
            res.end("\n");
            log.response(req, res);
        }
    }

    //-----------------------------------------------------------------------------
    // WebSocket functions
    function setupSocket(server) {
        new Wss({server : server}).on("connection", function (ws) {
            var remoteIP   = ws._socket.remoteAddress;
            var remotePort = ws._socket.remotePort;
            var cookie     = getCookie(ws.upgradeReq.headers.cookie);

            if (!cookie) {
                ws.close(4000);

                log.log(log.socket(remoteIP, remotePort), " Unauthorized WebSocket connection closed.");
                return;
            } else {
                log.log(log.socket(remoteIP, remotePort), " WebSocket ", "connected");
                if (!clients[cookie]) {
                    clients[cookie] = {};
                    clients[cookie].ws = ws;
                }
            }

            ws.on("message", function (message) {
                var msg = JSON.parse(message);
                switch (msg.type) {
                case "REQUEST_UPDATE":
                    clients[cookie] = {
                        directory: msg.data,
                        ws: ws
                    };
                    readDirectory(clients[cookie].directory, function () {
                        sendFiles(cookie, "UPDATE_FILES");
                    });
                    updateWatchers(clients[cookie].directory);
                    break;
                case "REQUEST_SHORTLINK":
                    // Check if we already have a link for that file
                    for (var link in db.shortlinks) {
                        if (db.shortlinks[link] === msg.data) {
                            sendLink(cookie, link);
                            return;
                        }
                    }

                    // Get a pseudo-random n-character lowercase string. The characters
                    // "l", "1", "i", o", "0" characters are skipped for easier communication of links.
                    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
                    do {
                        link = "";
                        while (link.length < config.linkLength)
                            link += chars.charAt(Math.floor(Math.random() * chars.length));
                    } while (db.shortlinks[link]); // In case the RNG generates an existing link, go again

                    log.log(log.socket(remoteIP, remotePort), " Shortlink created: " + link + " -> " + msg.data);
                    // Store the created link
                    db.shortlinks[link] = msg.data;

                    // Send the shortlink to the client
                    sendLink(cookie, link);
                    writeDB();
                    break;
                case "REQUEST_ZIP":
                    log.log(log.socket(remoteIP, remotePort), " Creating zip of " + msg.data);
                    createZip(msg.data, function (zip) {
                        log.log(log.socket(remoteIP, remotePort), " Zip created: " + msg.data);
                        send(clients[cookie].ws, JSON.stringify({
                            type : "ZIP_READY",
                            path :  path.relative(config.zipDir, zip.path).replace("\\", "/")
                        }));
                    });

                    break;
                case "DELETE_FILE":
                    log.log(log.socket(remoteIP, remotePort), " Deleting: " + msg.data.substring(1));
                    msg.data = addFilePath(msg.data);
                    checkWatchedDirs();

                    fs.stat(msg.data, function (error, stats) {
                        if (stats && !error) {
                            if (stats.isFile()) {
                                fs.unlink(msg.data, function (error) {
                                    if (error) log.error(error);
                                });
                            } else if (stats.isDirectory()) {
                                try {
                                    wrench.rmdirSyncRecursive(msg.data);
                                } catch (error) {
                                    // Specifically log this error as it possibly has to do with
                                    // wrench not using graceful-fs
                                    log.error("Error applying wrench.rmdirSyncRecursive");
                                    log.error(error);
                                }
                            }
                        }
                    });
                    break;
                case "CREATE_FOLDER":
                    var foldername = path.basename(msg.data);
                    if (/[\\\*\{\}\/\?\|<>"]/.test(foldername) || /^(\.+)$/.test(foldername)) {
                        log.log(log.socket(remoteIP, remotePort), " Invalid directory creation request: " + foldername);
                        return;
                    }

                    fs.mkdir(addFilePath(msg.data), config.dirMode, function (error) {
                        if (error) log.error(error);
                        log.log(log.socket(remoteIP, remotePort), " Created: ", msg.data);
                    });
                    break;
                case "RENAME":
                    var clientpath = clients[cookie].directory === "/" ? "/" : clients[cookie].directory + "/";
                    var newname = clientpath + msg.data.new,
                        oldname = clientpath + msg.data.old;
                    if (/[\\\*\{\}\/\?\|<>"]/.test(msg.data.new) || /^(\.+)$/.test(msg.data.new)) {
                        log.log(log.socket(remoteIP, remotePort), " Invalid rename request: " + newname);
                        return;
                    }

                    fs.rename(addFilePath(oldname), addFilePath(newname), function (error) {
                        if (error) log.error(error);
                        log.log(log.socket(remoteIP, remotePort), " Renamed: ", oldname, " -> ", newname);
                    });
                    break;
                case "SWITCH_FOLDER":
                    if (!/^\//.test(msg.data) || /^(\.+)$/.test(msg.data)) return;
                    clients[cookie].directory = msg.data;
                    updateWatchers(msg.data, function (ok) {
                        // Send client back to root in case the requested directory can't be read
                        if (!ok) clients[cookie].directory = "/";
                        readDirectory(clients[cookie].directory, function () {
                            sendFiles(cookie, ok ? "UPDATE_FILES" : "NEW_FOLDER");
                        });
                    });
                    break;
                case "GET_USERS":
                    if (!db.sessions[cookie].privileged) return;
                    sendUsers(cookie);
                    break;
                case "UPDATE_USER":
                    if (!db.sessions[cookie].privileged) return;
                    if (msg.data.pass === "") {
                        log.log(log.socket(remoteIP, remotePort), " Deleted user: ", log.color.magenta, msg.data.name, log.color.reset);
                        delUser(msg.data.name);
                        sendUsers(cookie);
                    } else {
                        log.log(log.socket(remoteIP, remotePort), " Added or updated user: ", log.color.magenta, msg.data.name, log.color.reset);
                        addOrUpdateUser(msg.data.name, msg.data.pass, msg.data.priv);
                        sendUsers(cookie);
                    }
                    break;
                case "GET_MIME":
                    send(clients[cookie].ws, JSON.stringify({
                        type : "MIME_TYPE",
                        req  : msg.data,
                        mime : mime.lookup(msg.data)
                    }));
                    break;
                case "ZERO_FILES":
                    msg.data.forEach(function (file) {
                        var p = addFilePath(clients[cookie].directory === "/" ? "/" : clients[cookie].directory + "/") + decodeURIComponent(file);
                        wrench.mkdirSyncRecursive(path.dirname(p), config.dirMode);
                        fs.writeFileSync(p, "", {mode: config.filesMode});
                        log.log(log.socket(remoteIP, remotePort), " Received: " + removeFilePath(p).substring(1));
                    });
                    send(clients[cookie].ws, JSON.stringify({ type : "UPLOAD_DONE" }));
                    break;
                }
            });

            ws.on("close", function (code) {
                var reason;
                if (code === 4001) {
                    reason = "(Logged out)";
                    delete db.sessions[cookie];
                    writeDB();
                } else if (code === 1001) {
                    reason = "(Going away)";
                    delete clients[cookie];
                }
                log.log(log.socket(remoteIP, remotePort), " WebSocket ", "disconnected", " ", reason || "(Code: " + (code || "none")  + ")");
            });

            ws.on("error", function (error) {
                log.error(error);
            });
        });
    }

    //-----------------------------------------------------------------------------
    // Send a WS event to the client containing an file list update
    var updateFuncs = {};
    function sendFiles(cookie, eventType, force) {
        if (!clients[cookie] || !clients[cookie].ws || !clients[cookie].ws._socket) return;

        var func = function (cookie, eventType) {
            var dir = clients[cookie].directory;
            var data = JSON.stringify({
                type   : eventType,
                folder : dir,
                data   : dirs[dir]
            });
            send(clients[cookie].ws, data);
        };

        if (!updateFuncs[cookie])
            updateFuncs[cookie] = utils.throttle(func, 250);

        if (!force)
            updateFuncs[cookie](cookie, eventType);
        else
            func(cookie, eventType);
    }

    //-----------------------------------------------------------------------------
    // Send a file link to a client
    function sendLink(cookie, link) {
        if (!clients[cookie] || !clients[cookie].ws) return;
        send(clients[cookie].ws, JSON.stringify({
            "type" : "SHORTLINK",
            "link" : link
        }));
    }

    //-----------------------------------------------------------------------------
    // Send a list of users on the server
    function sendUsers(cookie) {
        if (!clients[cookie] || !clients[cookie].ws) return;
        var userlist = {};
        for (var user in db.users) {
            if (db.users.hasOwnProperty(user)) {
                userlist[user] = db.users[user].privileged || false;
            }
        }
        send(clients[cookie].ws, JSON.stringify({
            type  : "USER_LIST",
            users : userlist
        }));
    }

    //-----------------------------------------------------------------------------
    // Do the actual sending
    function send(ws, data) {
        (function queue(ws, data, time) {
            if (time > 1000) return; // in case the socket hasn't opened after 1 second, cancel the sending
            if (ws && ws.readyState === 1) {
                ws.send(data, function (error) {
                    if (error) log.error(error);
                });
            } else {
                setTimeout(queue, 50, ws, data, time + 50);
            }
        })(ws, data, 0);
    }

    //-----------------------------------------------------------------------------
    // Watch the directory for realtime changes and send them to the appropriate clients.
    function createWatcher(directory) {
        var watcher = fs.watch(directory, utils.debounce(function () {
            var clientsToUpdate = [];
            for (var client in clients) {
                if (clients.hasOwnProperty(client)) {
                    var clientDir = clients[client].directory;
                    if (clientDir === removeFilePath(directory)) {
                        clientsToUpdate.push(client);
                        readDirectory(clientDir, function () {
                            sendFiles(clientsToUpdate.pop(), "UPDATE_FILES");
                        });
                    }
                }
            }
        }), config.readInterval);
        watcher.on("error", function (error) {
            log.error("Error trying to watch ", removeFilePath(directory), "\n", error);
        });
        watchers[removeFilePath(directory)] = watcher;
    }

    //-----------------------------------------------------------------------------
    // Watch given directory
    function updateWatchers(newDir, callback) {
        if (!watchers[newDir]) {
            newDir = addFilePath(newDir);
            fs.stat(newDir, function (error, stats) {
                if (error || !stats) {
                    // Requested Directory can't be read
                    checkWatchedDirs();
                    callback && callback(false);
                } else {
                    // Directory is okay to be read
                    createWatcher(newDir);
                    checkWatchedDirs();
                    callback && callback(true);
                }
            });
        } else {
            callback && callback(true);
        }
    }

    //-----------------------------------------------------------------------------
    // Check if we need the other active watchers
    function checkWatchedDirs() {
        var neededDirs = {};
        for (var client in clients) {
            if (clients.hasOwnProperty(client)) {
                neededDirs[clients[client].directory] = true;
            }
        }

        for (var directory in watchers) {
            if (!neededDirs[directory]) {
                watchers[directory].close();
                delete watchers[directory];
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Read resources and store them in the cache object
    function cacheResources(dir, callback) {
        var gzipFiles, relPath, fileName, fileData, fileTime;
        dir = dir.substring(0, dir.length - 1); // Strip trailing slash

        utils.walkDirectory(dir, function (error, results) {
            if (error) log.error(error);
            gzipFiles = [];
            results.forEach(function (fullPath) {
                relPath = fullPath.substring(dir.length + 1);
                fileName = path.basename(fullPath);

                try {
                    fileData = fs.readFileSync(fullPath);
                    fileTime = fs.statSync(fullPath).mtime;
                } catch (error) {
                    log.error(error);
                }

                cache[relPath] = {};
                cache[relPath].data = fileData;
                cache[relPath].etag = crypto.createHash("md5").update(String(fileTime)).digest("hex");
                cache[relPath].mime = mime.lookup(fullPath);
                if (/.*(js|css|html|svg)$/.test(fileName)) {
                    gzipFiles.push(relPath);
                }
            });

            if (gzipFiles.length > 0)
                runGzip();
            else
                callback();

            function runGzip() {
                var currentFile = gzipFiles[0];
                zlib.gzip(cache[currentFile].data, function (error, compressedData) {
                    if (error) log.error(error);
                    cache[currentFile].gzipData = compressedData;
                    gzipFiles = gzipFiles.slice(1);
                    if (gzipFiles.length > 0)
                        runGzip();
                    else
                        callback();
                });
            }
        });
    }
    //-----------------------------------------------------------------------------
    function handleGET(req, res) {
        var URI = decodeURIComponent(req.url);
        if (URI === "/") {
            handleResourceRequest(req, res, "base.html");
        } else if (/^\/content\//.test(URI)) {
            if (firstRun) {
                res.setHeader("X-Page-Type", "firstrun");
                handleResourceRequest(req, res, "auth.html");
            } else if (getCookie(req.headers.cookie)) {
                res.setHeader("X-Page-Type", "main");
                handleResourceRequest(req, res, "main.html");
            } else {
                res.setHeader("X-Page-Type", "auth");
                handleResourceRequest(req, res, "auth.html");
            }
        } else if (/^\/~\//.test(URI) || /^\/\$\//.test(URI) || /^\/\$\$\//.test(URI)) {
            handleFileRequest(req, res);
        } else if (/^\/res\//.test(URI)) {
            handleResourceRequest(req, res, req.url.substring(5));
        } else if (URI === "/favicon.ico") {
            handleResourceRequest(req, res, "favicon.ico");
        } else {
            var cookie = getCookie(req.headers.cookie);
            if (!cookie) {
                res.statusCode = 301;
                res.setHeader("Location", "/");
                res.end();
                log.response(req, res);
                return;
            }

            // Check if client is going to a folder directly
            fs.stat(path.join(config.filesDir, URI), function (error, stats) {
                if (!error && stats.isDirectory()) {
                    handleResourceRequest(req, res, "base.html");
                    // Strip trailing slash
                    if (URI.charAt(URI.length - 1) === "/")
                        URI = URI.substring(0, URI.length - 1);

                    if (!clients[cookie]) clients[cookie] = {};
                    clients[cookie].directory = URI;
                    updateWatchers(URI);
                } else {
                    res.statusCode = 301;
                    res.setHeader("Location", "/");
                    res.end();
                    log.response(req, res);
                }
            });
        }
    }

    //-----------------------------------------------------------------------------
    var blocked = [];
    function handlePOST(req, res) {
        var URI = decodeURIComponent(req.url), body = "";
        if (URI === "/upload") {
            if (!getCookie(req.headers.cookie)) {
                res.statusCode = 401;
                res.end();
                log.response(req, res);
            }
            handleUploadRequest(req, res);
        } else if (URI === "/login") {
            // Throttle login attempts to 1 per second
            if (blocked.indexOf(req.socket.remoteAddress) >= 0) {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end();
                return;
            }
            blocked.push(req.socket.remoteAddress);
            (function (ip) {
                setTimeout(function () {
                    blocked.pop(ip);
                }, 1000);
            })(req.socket.remoteAddress);

            req.on("data", function (data) { body += data; });
            req.on("end", function () {
                var postData = require("querystring").parse(body);
                if (isValidUser(postData.username, postData.password)) {
                    log.log(log.socket(req.socket.remoteAddress, req.socket.remotePort), " User ", postData.username, "authenticated");
                    createCookie(req, res, postData);
                    endReq(req, res, "OK");
                } else {
                    log.log(log.socket(req.socket.remoteAddress, req.socket.remotePort), " User ", postData.username, "unauthorized");
                    endReq(req, res, "NOK");
                }
            });
        } else if (URI === "/adduser" && firstRun) {
            req.on("data", function (data) { body += data; });
            req.on("end", function () {
                var postData = require("querystring").parse(body);
                if (postData.username !== "" && postData.password !== "") {
                    addOrUpdateUser(postData.username, postData.password, true);
                    createCookie(req, res, postData);
                    firstRun = false;
                    endReq(req, res, "OK");
                } else {
                    endReq(req, res, "NOK");
                }
            });
        }

        function endReq(req, res, response) {
            var json = JSON.stringify(response);
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Length", json.length);
            res.end(json);
            log.response(req, res);
        }
    }

    //-----------------------------------------------------------------------------
    function handleResourceRequest(req, res, resourceName) {

        // Shortcut for CSS debugging when no Websocket is available
        if (config.debug && resourceName === "style.css") {
            cssCache = [
                fs.readFileSync(getSrcPath("style.css")).toString("utf8"),
                fs.readFileSync(getSrcPath("sprites.css")).toString("utf8")
            ].join("\n");
            cssCache = ap("last 2 versions").compile(cssCache);
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.setHeader("Cache-Control", "private, no-cache, no-transform, no-store");
            res.setHeader("Content-Length", Buffer.byteLength(cssCache, "utf8"));
            res.end(cssCache);
            log.response(req, res);
            return;
        }

        // Regular resource handling
        if (cache[resourceName] === undefined) {
            if (resourceName === "null") { // Serve an empty document for the dummy iframe
                res.end();
                return;
            }
            res.statusCode = 404;
            res.end();
        } else {
            if ((req.headers["if-none-match"] || "") === cache[resourceName].etag) {
                res.statusCode = 304;
                res.end();
            } else {
                res.statusCode = 200;

                if (req.url === "/") {
                    // Disallow framing except when debugging
                    !config.debug && res.setHeader("X-Frame-Options", "DENY");
                    // Set the IE10 compatibility mode
                    if (req.headers["user-agent"] && req.headers["user-agent"].indexOf("MSIE") > 0)
                        res.setHeader("X-UA-Compatible", "IE=Edge, chrome=1");
                } else if (/^\/content\//.test(req.url)) {
                    // Don't ever cache /content since its data is dynamic
                    res.setHeader("Cache-Control", "private, no-cache, no-transform, no-store");
                } else if (resourceName === "favicon.ico") {
                    // Set a long cache on the favicon, as some browsers seem to request them constantly
                    res.setHeader("Cache-Control", "max-age=7257600");
                } else {
                    // All other content can be cached
                    res.setHeader("ETag", cache[resourceName].etag);
                }

                if (/.*(js|css|html|svg)$/.test(resourceName))
                    res.setHeader("Content-Type", cache[resourceName].mime + "; charset=utf-8");
                else
                    res.setHeader("Content-Type", cache[resourceName].mime);

                var acceptEncoding = req.headers["accept-encoding"] || "";
                if (/\bgzip\b/.test(acceptEncoding) && cache[resourceName].gzipData !== undefined) {
                    res.setHeader("Content-Encoding", "gzip");
                    res.setHeader("Content-Length", cache[resourceName].gzipData.length);
                    res.setHeader("Vary", "Accept-Encoding");
                    res.end(cache[resourceName].gzipData);
                } else {
                    res.setHeader("Content-Length", cache[resourceName].data.length);
                    res.end(cache[resourceName].data);
                }
            }
        }
        log.response(req, res);
    }

    //-----------------------------------------------------------------------------
    function handleFileRequest(req, res) {
        var URI = decodeURIComponent(req.url).substring(3), shortLink, dispo, filepath;

        // Check for a shortlink
        if (/^\/\$\//.test(req.url) && db.shortlinks[URI] && URI.length  === config.linkLength)
            shortLink = db.shortlinks[URI];

        // Validate the cookie for the remaining requests
        if (!getCookie(req.headers.cookie) && !shortLink) {
            res.statusCode = 301;
            res.setHeader("Location", "/");
            res.end();
            log.response(req, res);
            return;
        }

        // Check for a zip link
        if (/^\/\$\$\//.test(req.url)) {
            var zippath = path.join(config.zipDir, decodeURIComponent(req.url.substring(4)));
            try {
                fs.statSync(zippath);
                filepath = zippath;
            } catch (error) {
                res.statusCode = 404;
                res.setHeader("Location", "/");
                res.end();
                log.error("Zip " + zippath + " not found!\n", error);
            }
        } else filepath = shortLink ? addFilePath(shortLink) : addFilePath("/" + URI);

        if (filepath) {
            var mimeType = mime.lookup(filepath);

            fs.stat(filepath, function (error, stats) {
                if (!error && stats) {
                    res.statusCode = 200;
                    if (shortLink) {
                        // IE 10/11 can't handle an UTF-8 Content-Dispotsition header, so we encode it
                        if (req.headers["user-agent"] && req.headers["user-agent"].indexOf("MSIE") > 0)
                            dispo = ['attachment; filename="', encodeURIComponent(path.basename(filepath)), '"'].join("");
                        else
                            dispo = ['attachment; filename="', path.basename(filepath), '"'].join("");
                    } else {
                        dispo = "attachment";
                    }
                    res.setHeader("Content-Disposition", dispo);
                    res.setHeader("Content-Type", mimeType);
                    res.setHeader("Content-Length", stats.size);
                    log.response(req, res);
                    fs.createReadStream(filepath, {bufferSize: 4096}).pipe(res);
                } else {
                    res.statusCode = 500;
                    res.end();
                    log.response(req, res);
                    if (error)
                        log.error(error);
                }
            });
        }
    }

    //-----------------------------------------------------------------------------
    function handleUploadRequest(req, res) {
        var socket = log.socket(req.socket.remoteAddress, req.socket.remotePort),
            cookie = getCookie(req.headers.cookie);

        log.log(socket, " Upload started");

        // TODO: Figure out a client's directory if we don't have it at this point
        // (happens on server shutdown with the client staying on the page)
        if (!clients[cookie]) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain");
            res.end();
            log.response(req, res);
            return;
        }

        var busboy = new Busboy({ headers: req.headers }),
            infiles = 0,
            outfiles = 0,
            done = false,
            files = [];

        busboy.on("file", function (fieldname, file, filename) {
            ++infiles;
            onFile(fieldname, file, filename, function () {
                ++outfiles;
                if (done && infiles === outfiles) {
                    var names = Object.keys(files);
                    while (names.length > 0) {
                        (function (name) {
                            wrench.mkdirSyncRecursive(path.dirname(files[name].dst), config.dirMode);
                            fs.rename(files[name].src, files[name].dst, function () {
                                log.log(socket, " Received: " + clients[cookie].directory.substring(1) + "/" + name);
                            });
                        })(names.pop());
                    }
                }
            });
        });

        busboy.on("end", function () {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain");
            res.setHeader("Connection", "close");
            res.end();
            done = true;
            send(clients[cookie].ws, JSON.stringify({ type : "UPLOAD_DONE" }));
        });
        req.on("close", function () { !done && log.log(socket, " Upload cancelled"); });
        req.pipe(busboy);

        function onFile(fieldname, file, filename, next) {
            var dstRelative = filename ? decodeURIComponent(filename) : fieldname,
                dst = path.join(config.filesDir, clients[cookie].directory, dstRelative),
                tmp = path.join(config.incomingDir, crypto.createHash("md5").update(String(dst)).digest("hex")),
                fstream = fs.createWriteStream(tmp);

            files[dstRelative] = {
                src: tmp,
                dst: decodeURIComponent(dst)
            };

            fstream.on("close", function () {
                next();
            });

            file.pipe(fstream);
        }
    }

    //-----------------------------------------------------------------------------
    // Read a directory's content
    function readDirectory(root, callback) {
        fs.readdir(addFilePath(root), function (error, files) {
            var dirContents = {}, done = 0, last = files.length;
            if (error) log.error(error);
            if (!files) return;

            if (files.length === 0) {
                dirs[root] = dirContents;
                callback();
            }

            function checkDone() {
                done++;
                if (done === last) {
                    dirs[root] = dirContents;
                    callback();
                }
            }

            for (var i = 0 ; i < last; i++) {
                (function (entry) {
                    fs.stat(addFilePath(root) + "/" + entry, function (error, stats) {
                        if (!error && stats) {
                            if (stats.isFile()) {
                                dirContents[entry] = { type: "f", size: stats.size, mtime : stats.mtime.getTime() || 0 };
                                checkDone();
                            } else if (stats.isDirectory()) {
                                du(addFilePath(root) + "/" + entry, function (error, size) {
                                    if (error) log.error(error);
                                    dirContents[entry] = { type: "d", size: size, mtime : stats.mtime.getTime() || 0 };
                                    checkDone();
                                });
                            }
                        } else if (error) {log.error(error); callback(); }
                    });
                })(files[i]);
            }
        });
    }
    //-----------------------------------------------------------------------------
    // Get a directory's size (the sum of all files inside it)
    // TODO: caching of results
    function du(dir, callback) {
        fs.stat(dir, function (error, stat) {
            if (error) return callback(error);
            if (!stat) return callback(null, 0);
            if (!stat.isDirectory()) return callback(null, stat.size);
            fs.readdir(dir, function (error, list) {
                if (error) return callback(error);
                async.map(list.map(function (f) { return path.join(dir, f); }), function (f, callback) { return du(f, callback); },
                    function (error, sizes) {
                        callback(error, sizes && sizes.reduce(function (p, s) {
                            return p + s;
                        }, stat.size));
                    }
                );
            });
        });
    }
    //-----------------------------------------------------------------------------
    // Create a zip file from a directory
    // The callback recieves an object with the path and size of the file
    // TODO: push zipping of a directory to all clients
    var zipInProgress = [];
    function createZip(dir, callback) {
        var archive = archiver.create("zip", {zlib: { level: config.zipLevel }}), output,
            zipPath = path.join(config.zipDir, dir) + ".zip";

        // Don't start the same job twice
        for (var i = 0, l = zipInProgress.length; i < l; i++) {
            if (zipInProgress[i] === dir)
                return;
            else
                zipInProgress.push(dir);
        }

        wrench.mkdirSyncRecursive(path.dirname(zipPath), config.dirMode);

        output = fs.createWriteStream(zipPath);
        output.on("close", function () {
            fs.stat(zipPath, function (error, stats) {
                callback({path: zipPath, size: stats.size});
                zipInProgress.pop(dir);
            });
        });

        archive.setMaxListeners(0);
        archive.on("error", function (error) { log.error(error); });
        archive.pipe(output);

        utils.walkDirectory(addFilePath(dir), function (error, paths) {
            var read = 0, toread = paths.length;
            if (error) log.error(error);
            while (paths.length) {
                (function (currentPath) {
                    fs.readFile(currentPath, function (err, data) {
                        if (error) log.error(error);
                        read++;
                        archive.append(data, {name: removeFilePath(currentPath)});
                        if (read === toread) archive.finalize(function (error) { if (error) log.error(error); });
                    });
                })(paths.pop());
            }
        });
    }

    //-----------------------------------------------------------------------------
    // Argument handler
    function handleArguments() {
        var args = process.argv.slice(2), option = args[0];

        if (option === "list" && args.length === 1) {
            readDB();
            var out = ["Active Users: "];
            Object.keys(db.users).forEach(function (user) {
                out.push(log.color.magenta, user, log.color.reset, ", ");
            });
            log.simple.apply(null, out.length > 1 ? out.slice(0, out.length - 2) : out);
            process.exit(0);
        } else if (option === "add" && args.length === 3) {
            readDB();
            process.exit(addOrUpdateUser(args[1], args[2], true));
        } else if (option === "del" && args.length === 2) {
            readDB();
            process.exit(delUser(args[1]));
        } else if (option === "version") {
            log.simple(version);
            process.exit(0);
        } else {
            printUsage(1);
        }

        function printUsage(exitCode) {
            log.simple(log.usage);
            process.exit(exitCode);
        }
    }

    //-----------------------------------------------------------------------------
    // config.json handling
    function parseConfig() {
        var doWrite;

        // Copy config.json.example to config.json if it doesn't exist
        try {
            fs.statSync(configFile);
        } catch (error) {
            if (error.code === "ENOENT") {
                log.simple(log.color.yellow, " ->> ", log.color.reset, "creating ", log.color.magenta, configFile, log.color.reset, "...");
                fs.writeFileSync(configFile, fs.readFileSync(configFile + ".example"));
            } else {
                log.error("Error reading ", configFile, ":\n", error);
                process.exit(1);
            }
        }

        // Parse it
        try {
            config = JSON.parse(fs.readFileSync(configFile));
        } catch (error) {
            log.error("Error parsing ", configFile, ":\n", error);
            process.exit(1);
        }

        // Check if all options exist and add missing ones
        var opts = [
            "debug", "useHTTPS", "useSPDY", "port", "readInterval", "filesMode", "dirMode", "linkLength", "maxOpen", "zipLevel",
            "timestamps", "httpsKey", "httpsCert", "db", "filesDir", "incomingDir", "zipDir", "resDir", "srcDir"
        ];

        for (var i = 0, len = opts.length; i < len; i++) {
            if (config[opts[i]] === undefined) {
                log.simple(log.color.yellow, " ->> ", log.color.reset, "adding option ", log.color.cyan, opts[i], log.color.reset, " to config.json...");
                config[opts[i]] = JSON.parse(fs.readFileSync("config.json.example"))[opts[i]];
                doWrite = true;
            }
        }
        doWrite && writeConfig();

        // Change relative paths to __dirname
        ["httpsKey", "httpsCert", "db", "filesDir", "incomingDir", "zipDir", "resDir", "srcDir"].forEach(function (p) {
            if (config[p][0] === ".") {
                config[p] = path.join(__dirname + config[p].substring(1));
            }
        });
    }

    //-----------------------------------------------------------------------------
    // Read and validate the user database
    function readDB() {
        var dbString = "";
        var doWrite = false;

        try {
            dbString = String(fs.readFileSync(config.db));
            db = JSON.parse(dbString);

            // Create sub-objects in case they aren't here
            if (Object.keys(db).length !== 3) doWrite = true;
            if (!db.users) db.users = {};
            if (!db.sessions) db.sessions = {};
            if (!db.shortlinks) db.shortlinks = {};
        } catch (error) {
            if (error.code === "ENOENT" || /^\s*$/.test(dbString)) {
                db = {users: {}, sessions: {}, shortlinks: {}};

                // Recreate DB file in case it doesn't exist / is empty
                log.simple(log.color.yellow, " ->> ", log.color.reset, "creating ", log.color.magenta, path.basename(config.db), log.color.reset, "...");
                doWrite = true;
            } else {
                log.error("Error reading ", config.db, "\n", util.inspect(error));
                process.exit(1);
            }
        }

        // Write a new DB if necessary
        doWrite && writeDB();
    }

    //-----------------------------------------------------------------------------
    // Add a user to the database
    function addOrUpdateUser(user, password, privileged) {
        var salt = crypto.randomBytes(4).toString("hex"), isNew = !db.users[user];
        db.users[user] = {
            hash: utils.getHash(password + salt + user) + "$" + salt,
            privileged: privileged
        };
        writeDB();
        if (isCLI) log.simple(log.color.magenta, user, log.color.reset, " successfully ", isNew ? "added." : "updated.");
        return 1;
    }
    //-----------------------------------------------------------------------------
    // Remove a user from the database
    function delUser(user) {
        if (db.users[user]) {
            delete db.users[user];
            writeDB();
            if (isCLI) log.simple(log.color.magenta, user, log.color.reset, " successfully removed.");
            return 0;
        } else {
            if (isCLI) log.simple(log.color.magenta, user, log.color.reset, " does not exist!");
            return 1;
        }
    }

    //-----------------------------------------------------------------------------
    // Check if user/password is valid
    function isValidUser(user, pass) {
        var parts;
        if (db.users[user]) {
            parts = db.users[user].hash.split("$");
            if (parts.length === 2 && parts[0] === utils.getHash(pass + parts[1] + user))
                return true;
        }
        return false;
    }

    //-----------------------------------------------------------------------------
    // Cookie helpers
    function getCookie(cookie) {
        var session = "";
        if (cookie) {
            var cookies = cookie.split("; ");
            cookies.forEach(function (c) {
                if (/^session.*/.test(c)) {
                    session = c.substring(8);
                }
            });
            for (var savedsession in db.sessions) {
                if (savedsession === session) {
                    return session;
                }
            }
        }
        return false;
    }

    //-----------------------------------------------------------------------------
    function createCookie(req, res, postData) {
        var sessionID = crypto.randomBytes(32).toString("base64");
        var priv = db.users[postData.username].privileged;

        if (postData.check === "on") {
            // Create a semi-permanent cookie
            var dateString = new Date(Date.now() + 31536000000).toUTCString();
            res.setHeader("Set-Cookie", "session=" + sessionID + "; Expires=" + dateString);
        } else {
            // Create a single-session cookie
            // TODO: Delete these session ids after a certain period of inactivity from the client
            res.setHeader("Set-Cookie", "session=" + sessionID + ";");
        }
        db.sessions[sessionID] = {privileged : priv};
        writeDB();
    }

    //-----------------------------------------------------------------------------
    // Watch the CSS files and send updates to the client for live styling
    function watchCSS() {
        var cssfile = config.srcDir + "style.css";
        fs.watch(cssfile, utils.debounce(function () {
            cssCache = [
                fs.readFileSync(getSrcPath("style.css")).toString("utf8"),
                fs.readFileSync(getSrcPath("sprites.css")).toString("utf8")
            ].join("\n");
            cssCache = ap("last 2 versions").compile(cssCache);
            for (var client in clients) {
                if (clients.hasOwnProperty(client)) {
                    var data = JSON.stringify({
                        "type"  : "UPDATE_CSS",
                        "css"   : cssCache
                    });
                    if (clients[client].ws && clients[client].ws.readyState === 1) {
                        clients[client].ws.send(data, function (error) {
                            if (error) log.error(error);
                        });
                    }
                }
            }
        }), config.readInterval);
    }

    //-----------------------------------------------------------------------------
    // Various helper functions
    function writeDB()         { fs.writeFileSync(config.db, JSON.stringify(db, null, 4)); }
    function writeConfig()     { fs.writeFileSync(configFile, JSON.stringify(config, null, 4)); }

    function getResPath(name)  { return path.join(config.resDir, name); }
    function getSrcPath(name)  { return path.join(config.srcDir, name); }

    // removeFilePath is intentionally not an inverse to the add function
    function addFilePath(p)    { return utils.fixPath(config.filesDir + p); }
    function removeFilePath(p) { return utils.fixPath("/" + utils.fixPath(p).replace(utils.fixPath(config.filesDir), "")); }

    //-----------------------------------------------------------------------------
    // Process signal and events
    process
        .on("SIGINT",  function () { shutdown("SIGINT");  })
        .on("SIGQUIT", function () { shutdown("SIGQUIT"); })
        .on("SIGTERM", function () { shutdown("SIGTERM"); })
        .on("uncaughtException", function (error) {
            log.error("=============== Uncaught exception! ===============");
            log.error(error.stack);
        });

    //-----------------------------------------------------------------------------
    function shutdown(signal) {
        log.log("Received " + signal + " - Shutting down...");
        var count = 0;
        for (var client in clients) {
            if (clients.hasOwnProperty(client)) {
                if (!clients[client] || !clients[client].ws) continue;
                if (clients[client].ws.readyState < 2) {
                    count++;
                    clients[client].ws.close(1001);
                }
            }
        }

        if (count > 0) log.log("Closed " + count + " active WebSocket" + (count > 1 ? "s" : ""));
        process.exit(0);
    }
})();