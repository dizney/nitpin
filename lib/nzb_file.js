var Blast = __Protoblast,
    Str = Blast.Bound.String,
    Fn = Blast.Bound.Function,
    PassThrough = require('stream').PassThrough,
    SlowBuffer = require('buffer').SlowBuffer,
    libpath = require('path'),
    Yencer = require('yencer'),
    fs = require('graceful-fs'),
    NzbFile;

/**
 * The NzbFile class: a wrapper for a file entry inside an NZB
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.1
 * @version  0.1.4
 *
 * @param    {NzbDocument}   parent
 * @param    {Object}        filedata
 */
NzbFile = Fn.inherits('Informer', function NzbFile(parent, filedata) {

	var that = this;

	// The parent NZB document
	this.nzb = parent;

	// The nitpin instance
	this.server = parent.server;

	// The data of this file
	this.data = filedata;

	// The filename
	this.name = filedata.filename;

	// The segments (usenet articles)
	this.segments = filedata.segments;

	// The amount of downloaded segments
	this.finishedSegments = 0;

	// The suborder (like a rar-part file)
	this.suborder = 0;

	// The getBody jobs
	this.jobs = [];

	// Has the download finished?
	this.downloaded = false;

	// Is there a repaired file available
	this.repaired = null;

	// Did this file contain corrupted pieces
	this.corrupted = null;

	// Segment success counts
	this.successCount = 0;

	// Segment fail counts
	this.failCount = 0;

	// Has a repair been requested?
	this.requestedRepair = false;

	// Is this a rar file?
	this.isRar = false;

	// Extract some more information
	this.triage();

	// The deyenc queue
	this.yenqueue = parent.yenqueue;

	// The file/segment queue
	this.filequeue = parent.filequeue;
});

/**
 * Prepare the downloadsize of this nzb
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.4
 * @version  0.1.4
 *
 * @type     {Number}
 */
NzbFile.prepareProperty(function downloadsize() {

	var bytes = 0,
	    i;

	for (i = 0; i < this.segments.length; i++) {
		bytes += this.segments[i].bytes;
	}

	return bytes;
});

/**
 * The current progress percentage as a getter property
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.3
 * @version  0.1.3
 *
 * @type     {Number}
 */
NzbFile.setProperty(function progress() {
	return ~~((this.finishedSegments / this.segments.length) * 100);
});

/**
 * Mark segment result
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.4
 * @version  0.1.4
 */
NzbFile.setMethod(function markSegment(segment, corrupt) {

	if (segment.alreadyMarked) {
		return;
	}

	if (corrupt) {
		this.corrupted = true;
		this.failCount++;

		this.nzb.readyForPar(this, segment);
		this.requestedRepair = true;
	} else {
		this.successCount++;
	}

	segment.alreadyMarked = true;
});

/**
 * Debug method
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.3
 * @version  0.1.3
 */
NzbFile.setMethod(function debug() {

	if (!this.server.debugMode) {
		return false;
	}

	return this.server.debug('__debug__', 'NZBFILE', arguments);
});

/**
 * Abort the download.
 * Already made requests will not be aborted.
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.3
 * @version  0.1.3
 */
NzbFile.setMethod(function abort() {

	var aborted = 0;

	this.debug('Aborting file', this.name);

	// Cancel all the jobs
	this.jobs.forEach(function eachJob(job) {
		if (!job.executed && !job.cancelled) {
			abort++;
			job.cancel();
		}
	});

	if (aborted) {
		this.emit('aborted', aborted);
	}
});

/**
 * Pause the download.
 * Already made requests will not be aborted.
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.3
 * @version  0.1.3
 */
NzbFile.setMethod(function pause() {

	var paused = 0;

	this.debug('Pausing file', this.name);

	// Cancel all the jobs
	this.jobs.forEach(function eachJob(job) {
		if (!job.executed && !job.cancelled && !job.paused) {
			paused++;
			job.pause();
		}
	});

	if (paused) {
		this.emit('paused', paused);
	}
});

/**
 * Resume the download
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.3
 * @version  0.1.3
 */
NzbFile.setMethod(function resume() {

	var resumed = 0;

	this.debug('Resuming file', this.name);

	// Cancel all the jobs
	this.jobs.forEach(function eachJob(job) {
		if (!job.executed && !job.cancelled && job.paused) {
			resumed++;
			job.resume();
		}
	});

	if (resumed) {
		this.emit('resumed', resumed);
	}
});

/**
 * Triage the file
 *
 * @author   Jelle De Loecker   <jelle@kipdola.be>
 * @since    0.1.1
 * @version  0.1.4
 */
NzbFile.setMethod(function triage() {

	var filename = this.name,
	    temp,
	    pars = this.nzb.pars,
	    rars = this.nzb.rars,
	    bases = this.nzb.rar_bases,
	    base;

	// Handle parchives
	if (Str.endsWith(filename, '.par2')) {

		// Skip parchives for sample files
		if (filename.indexOf('.sample.') > -1) {
			return;
		}

		this.parchive = true;

		if (filename.indexOf('.vol') == -1) {
			pars.main = this;
		} else {
			pars.others.push(this);
		}

		return;
	}

	// Handle rar files with the .rar extension
	if (Str.endsWith(filename, '.rar')) {

		// Look for "part#" in the name
		temp = /\Wpart(\d+)\.rar/.exec(filename);

		if (temp) {
			// These part files start at number 1 for the first file
			this.suborder = Number(temp[1]) - 1;

			// Get the base name
			base = filename.replace(/\Wpart(\d+)\.rar/, '');

			this.setRarBaseName(base);
		} else {
			// No "part#" found, is probably the first one
			this.suborder = 0;

			this.setRarBaseName(libpath.basename(filename, '.rar'));
		}
	} else {

		temp = /\.r(\d\d)$/.exec(filename);

		if (temp) {

			// These part files start at 0 for the SECOND part (first part has no number)
			this.suborder = Number(temp[1]) + 1;

			// Get the base name
			base = filename.replace(/\.r(\d\d)$/, '');

			this.setRarBaseName(base);
		}
	}
});

/**
 * Set the rar file base name
 *
 * @author   Jelle De Loecker <jelle@kipdola.be>
 * @since    0.1.4
 * @version  0.1.4
 *
 * @param    {String}   base_name
 */
NzbFile.setMethod(function setRarBaseName(base_name) {

	var bases = this.nzb.rar_bases;

	// Yes, this is a rar file
	this.isRar = true;

	if (!base_name) {
		return;
	}

	this.rar_base_name = base_name;

	// Increment the base_name counter
	if (!bases[base_name]) {
		bases[base_name] = 0;
	}

	bases[base_name]++;
});

/**
 * Create a stream to the file
 *
 * @author   Jelle De Loecker <jelle@kipdola.be>
 * @since    0.1.1
 * @version  0.1.4
 *
 * @param    {Number}   stream_weight      Higher weights get priority
 * @param    {Boolean}  ignoreCorruption
 */
NzbFile.setMethod(function stream(stream_weight, ignoreCorruption) {

	var that = this,
	    tasks = [],
	    orderTasks = [],
	    informer = new Blast.Classes.Informer(),
	    written = 0,
	    corrupted,
	    lastPart,
	    stream;

	if (ignoreCorruption) {
		that.debug('Created filestream for repairing', that.name);
	} else {
		that.debug('Created filestream', that.name);
	}

	if (this.parchive) {
		ignoreCorruption = true;
	}

	// Amount of corrupted/missing segments
	corrupted = 0;

	// The passthrough stream
	stream = new PassThrough();

	if (!stream_weight) {
		stream_weight = 10;
	}

	// Prepare the fetching of all the file segments
	this.segments.forEach(function eachSegment(segment, index) {

		var yfile,
		    fbuffer,
		    cachehit = false,
		    weight = 200000 * stream_weight;

		// Subtract the suborder
		weight -= (that.suborder * 1000);

		// Subtract the segment index
		weight -= (index * 10);

		// Queue the task that gets the actual segment
		that.filequeue.add(function getSegment(nextSegment) {

			var tempFilePath,
			    shared = {};

			// If *any* segment is corrupted during a non-repair stream,
			// stop processing them and let the ordertasks callback create a
			// listener for its repair
			if (corrupted && !ignoreCorruption) {
				informer.emit('defer-for-repair-' + index);
				return nextSegment();
			}

			Fn.series(function getCache(next) {

				// Try to get the segment from the temp folder
				that.nzb.getTemp(function gotTempPath(err, temppath) {

					if (err) {
						return next();
					}

					tempFilePath = libpath.resolve(temppath, Blast.Bound.String.slug(segment.id));

					// Open the temp file as a buffer
					fs.readFile(tempFilePath, {encoding: 'binary'}, function gotTempFileBuffer(err, buffer) {

						if (!err) {
							segment.from_cache = true;
							cachehit = true;
							shared.body = buffer;
							that.nzb.emit('got_segment', segment, buffer.length);
							buffer = null;
						}

						next();
					});
				});
			}, function getSegment(next) {

				// If we already got the body, go to the deyencing fase
				if (shared.body) {
					return next();
				}

				var job = that.server.getBodyWeight(that.data.groups, segment.id, weight, function gotSegment(err, response) {

					if (err) {
						that.debug('Server error getting segment', segment.id, 'for file', that.name + ':', err);

						that.markSegment(segment, true);
						that.emit('missed_segment', segment, 0);
						corrupted++;
					} else {

						shared.body = response;
						that.nzb.emit('got_segment', segment, response.length);

						// If we can write the article to someplace
						if (tempFilePath) {
							fs.createWriteStream(tempFilePath).end(response, 'binary');
						}
					}

					response = null;
					next();
				});

				that.jobs.push(job);
			}, function preYenc(next) {

				// If we don't know if it's a yenc file or not (because it wasn't in the subject)
				// Try looking in the segment itself
				if (that.data.yenc == null) {
					if (shared.body) {
						that.data.yenc = (shared.body.indexOf('=ybegin') > -1);
					} else {
						that.data.yenc = false;
					}
				}

				if (!that.data.yenc) {
					yfile = null;

					if (shared.body == null) {
						shared.body = 0;
					}

					fbuffer = new SlowBuffer(shared.body);
				}

				next();

			}, function deYenc(next) {

				if (that.data.yenc) {
					// Start decoding the segment
					yfile = new Yencer.YencFile(segment);

					if (!shared.body) {
						yfile.intact = false;

						// Create a buffer, use the expected article size
						yfile.buffer = new SlowBuffer(yfile.articlesize);

						// Indicate this file contained corrupted segments
						that.markSegment(segment, true);

						// Indicate that there is a corrupted segment
						corrupted++;

						fbuffer = yfile.buffer;

						that.debug('Using empty buffer for segment', segment.id, 'of size', yfile.articlesize);
					} else {

						that.yenqueue.add(function deYencThrottled(nextDeyenc) {

							yfile.decodePiece(shared.body);

							shared.body = null;

							if (!yfile.intact) {
								// Indicate this file contained corrupted segments
								that.markSegment(segment, true);
								corrupted++;
							} else {
								that.markSegment(segment, false);
							}

							fbuffer = yfile.buffer;
							nextDeyenc();
							next();
						}, null, {weight: weight});

						return;
					}
				} else {
					shared.body = null;
				}

				next();
			}, function done(err) {

				if (err) {
					that.debug('Unknown error getting segment', segment.id, 'for file', that.name + ':', err);
				}

				// Indicate this segment has downloaded,
				// but only do this on the first download.
				// (#stream can be called multiple times)
				if (!segment.downloaded) {
					segment.downloaded = true;
					that.finishedSegments++;

					// Emit progress event
					that.emit('progress', that.progress, segment.id, cachehit);
				}

				// Emit an event to indicate this segment is done
				informer.emit('ready-' + index);
				nextSegment(null);
			});
		}, null, {weight: weight});

		// Queue the task that pushed the decoded buffers to the stream in order
		orderTasks.push(function pusher(nextPush) {

			var myId = index;

			informer.after('defer-for-repair-' + index, function defer() {
				nextPush();
			});

			informer.after('ready-' + index, function segmentIsReady() {

				// The first corrupted piece emits the corrupted event
				if (corrupted == 1) {
					stream.emit('corrupted');
				}

				// Every corrupted piece emits itself
				if (yfile && !yfile.intact) {
					stream.emit('corrupted-piece', yfile);
				}

				// Only emit pieces when nothing has been corrupted
				if (corrupted == 0 || ignoreCorruption) {

					// Increase the written index
					written += fbuffer.length;

					// Write the buffer to the stream
					stream.write(fbuffer);
				}

				fbuffer = null;

				// Set the buffer to null
				if (yfile) {
					yfile.buffer = null;
					yfile = null;
				}

				nextPush();
			});
		});
	});

	// Queue the stream writes first (synchronously)
	Fn.series(false, orderTasks, function done(err) {

		that.debug('Ordertasks for file', that.name, 'is done. Corruption:', corrupted);

		if (err) {
			stream.emit('error', err);
		}

		if (that.parchive || ignoreCorruption) {
			stream.end();
		} else if (corrupted) {

			that.debug('Waiting for repair on file', '"' + that.name + '"', 'before continuing');

			// Wait for the repaired signal to continue the stream
			that.after('repaired', function repaired() {

				that.debug('Piping repaired file', that.name, 'starting at', written);

				// Pipe the repaired file to the stream
				fs.createReadStream(that.repaired, {start: written}).pipe(stream);
			});
		} else {
			stream.end();
		}

		that.downloaded = true;
		stream.emit('downloadEnd');
	});

	return stream;
});

module.exports = NzbFile;