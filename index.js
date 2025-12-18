const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// Helper function to normalize track names for finding track cuts files
// Removes session numbers, dates, and other common suffixes
function normalizeTrackName(trackName) {
  if (!trackName) return 'brands_hatch';
  
  let normalized = trackName
    .toLowerCase()
    .trim()
    // Remove common suffixes: "1", "2", "GP", "National", etc.
    .replace(/\s+(\d+|gp|national|international|club|indy)$/i, '')
    // Remove dates and times
    .replace(/\s+\d{4}-\d{2}-\d{2}/g, '')
    // Replace spaces with underscores
    .replace(/\s+/g, '_')
    // Remove any trailing numbers or underscores
    .replace(/[_\d]+$/, '');
  
  // Handle common track name variations
  const trackMap = {
    'brands': 'brands_hatch',
    'donington': 'donington',
    'silverstone': 'silverstone',
    'snetterton': 'snetterton',
  };
  
  // Check if normalized name matches any known track
  for (const [key, value] of Object.entries(trackMap)) {
    if (normalized.includes(key)) {
      return value;
    }
  }
  
  return normalized || 'brands_hatch';
}

// Load env from root directory to ensure we use the same credentials as frontend
const rootEnvPath = path.resolve(__dirname, '..', '.env');
require('dotenv').config({ path: rootEnvPath });
// Also try loading local .env if it exists (overrides root)
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase client with service role key (bypasses RLS for uploads)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Configure CORS
// app.use(cors({
//   origin: ['http://localhost:8080', 'http://localhost:5173'],
//   credentials: true
// }));

const allowedOrigins = [
  'http://localhost:8080',                     // local dev frontend
  'http://localhost:5173',                     // other dev port if used
  'https://laminar-frontend.onrender.com',     // production frontend
  'https://laminarinsights.vercel.app'
];

app.use(cors({
  origin: function(origin, callback){
    // allow requests with no origin (like Postman)
    if(!origin) return callback(null, true);

    if(allowedOrigins.indexOf(origin) === -1){
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// Preflight handler
app.options('*', cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

// Configure Multer for file uploads (no size limit on server)
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Upload server is running' });
});

// File upload endpoint
app.post('/api/upload-telemetry', upload.single('file'), async (req, res) => {
  console.log('📤 Upload request received');
  
  try {
    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    // Get user from token
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      console.error('❌ Auth error:', userError);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('✅ User authenticated:', user.email);

    // Get file and metadata from request
    const file = req.file;
    const { stintId, filePath } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    console.log(`📁 File received: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    // Store relative path for CLI usage - NOW UNUSED but keeping variable to avoid breaking if referenced later in this scope (though it seems unused)
    const relativeDataPath = null;
    
    // Upload to Supabase Storage

    console.log(`☁️ Uploading to Supabase: ${filePath}`);
    
    const fileContent = fs.readFileSync(file.path);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('telemetry-files')
      .upload(filePath, fileContent, {
        contentType: file.mimetype,
        upsert: true
      });

    // Clean up temp file
    fs.unlinkSync(file.path);

    if (uploadError) {
      console.error('❌ Upload error:', uploadError);
      return res.status(500).json({ error: uploadError.message });
    }

    console.log('✅ File uploaded successfully');

    // Update stint to "pending" status - Python workers will pick it up
    // (This replaces the parse-telemetry Edge Function call until it's deployed)
    console.log('📊 Updating stint status to pending...');
    
    const { error: updateError } = await supabase
      .from('stints')
      .update({
        processing_status: 'pending',
        processing_progress: 0,
        raw_file_path: filePath,
        metadata: {
          data_path: null // Local data path is deprecated
        }
      })
      .eq('id', stintId);

    if (updateError) {
      console.error('❌ Error updating stint:', updateError);
      return res.status(500).json({
        success: false,
        message: 'File uploaded but failed to queue for processing',
        error: updateError.message
      });
    }

    console.log('✅ Stint queued for processing');

    // Generate session summary using Python CLI
    try {
      console.log('🐍 Running build_session_summary.py...');
      
      // Get stint data to find telemetry file path and track
    const { data: stint, error: stintError } = await supabase
      .from('stints')
      .select(`
        *,
        track_sessions (
          event_id,
          events (
            track_name
          )
        )
      `)
      .eq('id', stintId)
      .single();

    if (stintError || !stint) {
      console.error('❌ Stint not found:', stintError);
      throw new Error('Stint not found');
    }

      // Get track name from stint metadata or use default
      // Track name comes from event via track_session
      const trackName = stint.track_sessions?.events?.track_name || 
                       stint.metadata?.track_name || 
                       stint.track_name || 
                       'brands_hatch';
      const trackSlug = normalizeTrackName(trackName);
      
      console.log(`📍 Track: "${trackName}" → ${trackSlug}_cuts.json`);
      
      // Paths - telemetry-kpi is at same level as car-txt-analyzer, not inside it
      const telemetryKpiDir = path.join(__dirname, '..', '..', 'telemetry-kpi');
      const summaryScript = path.join(telemetryKpiDir, 'build_session_summary.py');
      const trackCutsPath = path.join(telemetryKpiDir, 'track_cuts', `${trackSlug}_cuts.json`);
      const summariesDir = path.join(telemetryKpiDir, 'summaries');
      const summaryOutputPath = path.join(summariesDir, `stint_${stintId}_summary.json`);
      
      // Create summaries directory if it doesn't exist
      if (!fs.existsSync(summariesDir)) {
        fs.mkdirSync(summariesDir, { recursive: true });
      }

      // Download the telemetry file from Supabase Storage to temp location
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('telemetry-files')
        .download(filePath);
      
      if (downloadError || !fileData) {
        console.error('❌ Failed to download file for processing:', downloadError);
        throw new Error('Failed to download telemetry file');
      }

      const tempTelemetryPath = path.join(__dirname, 'temp', `${stintId}.txt`);
      const tempDir = path.dirname(tempTelemetryPath);
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const arrayBuffer = await fileData.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempTelemetryPath, buffer);

      // Check if track cuts file exists
      if (!fs.existsSync(trackCutsPath)) {
        console.warn(`⚠️ Track cuts not found: ${trackCutsPath}, using default`);
        // Use Brands Hatch as fallback
        const fallbackCutsPath = path.join(telemetryKpiDir, 'track_cuts', 'brands_hatch_cuts.json');
        if (!fs.existsSync(fallbackCutsPath)) {
          throw new Error('No track cuts files available');
        }
      }

      // Run Python script (use 'py' on Windows)
      await new Promise((resolve, reject) => {
        const pythonProcess = spawn('py', [
          summaryScript,
          tempTelemetryPath,
          '--cuts', trackCutsPath,
          '--output', summaryOutputPath
        ], {
          env: { 
            ...process.env,
            PYTHONIOENCODING: 'utf-8' // Fix Windows encoding issues
          }
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
          console.log(`[Python] ${data.toString().trim()}`);
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
          console.error(`[Python Error] ${data.toString().trim()}`);
        });

        pythonProcess.on('close', (code) => {
          // Clean up temp telemetry file
          if (fs.existsSync(tempTelemetryPath)) {
            fs.unlinkSync(tempTelemetryPath);
          }

          if (code !== 0) {
            reject(new Error(`Python script exited with code ${code}: ${stderr}`));
          } else {
            resolve();
          }
        });

        pythonProcess.on('error', (err) => {
          // Clean up temp file on error
          if (fs.existsSync(tempTelemetryPath)) {
            fs.unlinkSync(tempTelemetryPath);
          }
          reject(err);
        });
      });

      console.log('✅ Session summary generated');

      // Read the generated summary JSON
      const summaryJson = JSON.parse(fs.readFileSync(summaryOutputPath, 'utf8'));

      // Upload summary JSON to Supabase Storage
      const summaryStoragePath = `summaries/stint_${stintId}_summary.json`;
      const { error: summaryUploadError } = await supabase.storage
        .from('telemetry-files')
        .upload(summaryStoragePath, JSON.stringify(summaryJson, null, 2), {
          contentType: 'application/json',
          upsert: true
        });

      if (summaryUploadError) {
        console.error('❌ Failed to upload summary JSON:', summaryUploadError);
      } else {
        console.log('✅ Summary JSON uploaded to Supabase Storage');
      }

      // Parse and insert laps into database
      const laps = summaryJson.session.laps || [];
      const fastestLapIndex = summaryJson.session.fastest_lap_index;

      console.log(`📊 Inserting ${laps.length} laps into database...`);

      for (const lap of laps) {
        const { error: lapInsertError } = await supabase
          .from('laps')
          .upsert({
            stint_id: stintId,
            lap_number: lap.lap_index,
            lap_time: lap.time_s,
            lap_time_str: lap.time_str,
            is_fastest: lap.lap_index === fastestLapIndex,
            is_outlap: lap.is_outlap || false,
            is_inlap: lap.is_inlap || false,
            delta_to_best: lap.time_s && summaryJson.session.fastest_lap_time_s 
              ? lap.time_s - summaryJson.session.fastest_lap_time_s 
              : null,
            is_valid: !lap.is_outlap && !lap.is_inlap
          }, {
            onConflict: 'stint_id,lap_number'
          });

        if (lapInsertError) {
          console.error(`❌ Failed to insert lap ${lap.lap_index}:`, lapInsertError);
        }
      }

      console.log('✅ Laps inserted into database');

      // Insert theoretical best lap if available
      if (summaryJson.theoretical_best) {
        const { error: theoreticalInsertError } = await supabase
          .from('theoretical_best_laps')
          .upsert({
            stint_id: stintId,
            theoretical_lap_time_s: summaryJson.theoretical_best.theoretical_lap_time_s,
            theoretical_lap_time_str: summaryJson.theoretical_best.theoretical_lap_time_str,
            fastest_actual_lap_time_s: summaryJson.theoretical_best.fastest_actual_lap_time_s,
            potential_gain_s: summaryJson.theoretical_best.potential_gain_s,
            summary_json_path: summaryStoragePath
          }, {
            onConflict: 'stint_id'
          });

        if (theoreticalInsertError) {
          console.error('❌ Failed to insert theoretical best:', theoreticalInsertError);
        } else {
          console.log('✅ Theoretical best lap inserted');
        }
      }

      // Update stint status to completed
      await supabase
        .from('stints')
        .update({
          processing_status: 'completed',
          processing_progress: 100
        })
        .eq('id', stintId);

      console.log('✅ Session summary processing complete');

    } catch (summaryError) {
      console.error('❌ Session summary generation failed:', summaryError);
      // Update stint with error status
      await supabase
        .from('stints')
        .update({
          processing_status: 'error',
          error_message: summaryError.message
        })
        .eq('id', stintId);
    }

    // Return the expected response format
    res.json({
      success: true,
      message: 'File uploaded and processing started',
      stintId: stintId,
      filePath: filePath
    });

  } catch (error) {
    console.error('❌ Server error:', error);
    
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Report creation endpoint
app.post('/api/reports/create', async (req, res) => {
  console.log('📊 Report creation request received');
  
  const tempFiles = [];
  const tempDir = path.join(__dirname, 'temp', `report_${Date.now()}`);
  
  try {
    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      console.error('❌ Authentication failed:', authError);
      return res.status(401).json({ error: 'Authentication failed' });
    }

    console.log(`✅ User authenticated: ${user.email}`);

    const { stint_id, title, notes, lap_a_index, lap_b_index, file_b_stint_id } = req.body;

    if (!stint_id || !title || !lap_a_index || !lap_b_index) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Get stint A data with track info from event
    const { data: stintA, error: stintAError } = await supabase
      .from('stints')
      .select(`
        *,
        track_sessions (
          event_id,
          events (
            track_name
          )
        )
      `)
      .eq('id', stint_id)
      .single();

    if (stintAError || !stintA || !stintA.raw_file_path) {
      console.error('❌ Stint A not found:', stintAError);
      return res.status(404).json({ error: 'Stint not found or has no telemetry file' });
    }

    console.log(`📁 Downloading telemetry file A: ${stintA.raw_file_path}`);

    // Download telemetry file A
    const { data: fileDataA, error: downloadErrorA } = await supabase.storage
      .from('telemetry-files')
      .download(stintA.raw_file_path);

    if (downloadErrorA || !fileDataA) {
      console.error('❌ Failed to download telemetry file A:', downloadErrorA);
      return res.status(500).json({ error: 'Failed to download telemetry file' });
    }

    const tempFilePathA = path.join(tempDir, `${stint_id}.txt`);
    const bufferA = Buffer.from(await fileDataA.arrayBuffer());
    fs.writeFileSync(tempFilePathA, bufferA);
    tempFiles.push(tempFilePathA);

    console.log(`💾 Saved file A to: ${tempFilePathA}`);

    // Handle file B if cross-file comparison
    let tempFilePathB = null;
    let stintB = null;

    if (file_b_stint_id) {
      const { data: stintBData, error: stintBError } = await supabase
        .from('stints')
        .select('*')
        .eq('id', file_b_stint_id)
        .single();

      if (stintBError || !stintBData || !stintBData.raw_file_path) {
        console.error('❌ Stint B not found:', stintBError);
        return res.status(404).json({ error: 'Second stint not found' });
      }

      stintB = stintBData;
      console.log(`📁 Downloading telemetry file B: ${stintB.raw_file_path}`);

      const { data: fileDataB, error: downloadErrorB } = await supabase.storage
        .from('telemetry-files')
        .download(stintB.raw_file_path);

      if (downloadErrorB || !fileDataB) {
        console.error('❌ Failed to download file B:', downloadErrorB);
        return res.status(500).json({ error: 'Failed to download second telemetry file' });
      }

      tempFilePathB = path.join(tempDir, `${file_b_stint_id}.txt`);
      const bufferB = Buffer.from(await fileDataB.arrayBuffer());
      fs.writeFileSync(tempFilePathB, bufferB);
      tempFiles.push(tempFilePathB);

      console.log(`💾 Saved file B to: ${tempFilePathB}`);
    }

    // Determine track and get cuts path
    // Track name comes from event via track_session
    const trackName = stintA.track_sessions?.events?.track_name || 
                     stintA.metadata?.track_name || 
                     stintA.track_name || 
                     'brands_hatch';
    const trackSlug = normalizeTrackName(trackName);
    
    console.log(`📍 Track: "${trackName}" → ${trackSlug}_cuts.json`);
    
    const telemetryKpiDir = path.join(__dirname, '..', '..', 'telemetry-kpi');
    const compareScript = path.join(telemetryKpiDir, 'compare_any.py');
    const trackCutsPath = path.join(telemetryKpiDir, 'track_cuts', `${trackSlug}_cuts.json`);
    
    // Validate track cuts file exists
    if (!fs.existsSync(trackCutsPath)) {
      console.error(`❌ Track cuts not found for track: ${trackName} (slug: ${trackSlug})`);
      console.error(`   Looking for: ${trackCutsPath}`);
      
      // Try to find available track cuts
      const trackCutsDir = path.join(telemetryKpiDir, 'track_cuts');
      const availableCuts = fs.existsSync(trackCutsDir) 
        ? fs.readdirSync(trackCutsDir).filter(f => f.endsWith('_cuts.json'))
        : [];
      
      console.error(`   Available track cuts: ${availableCuts.join(', ') || 'none'}`);
      
      return res.status(400).json({ 
        error: `Track configuration not found for "${trackName}". Please check the stint metadata has a valid track_name.`,
        availableTracks: availableCuts.map(f => f.replace('_cuts.json', ''))
      });
    }
    
    console.log(`✅ Using track cuts: ${trackCutsPath}`);
    const outputDir = path.join(tempDir, 'output');

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Determine comparison mode based on lap indices
    let mode;
    if (tempFilePathB) {
      // Multi-file modes
      if (lap_a_index === 'theoretical' && lap_b_index === 'theoretical') {
        mode = 'theoretical_vs_theoretical';
      } else if (lap_a_index === 'fastest' && lap_b_index === 'theoretical') {
        mode = 'fastest_vs_theoretical';
      } else if (lap_a_index === 'fastest' && lap_b_index === 'fastest') {
        mode = 'fastest_vs_fastest';
      } else if (lap_a_index === 'theoretical' || lap_b_index === 'theoretical') {
        // One is theoretical, other is numeric lap
        mode = 'lap_vs_theoretical';
      } else {
        // Both are numeric laps
        mode = 'lap_vs_lap';
      }
    } else {
      // Single-file modes
      if (lap_a_index === 'fastest' && lap_b_index === 'theoretical') {
        mode = 'fastest_vs_theoretical_same_file';
      } else if (lap_a_index === 'theoretical' || lap_b_index === 'theoretical') {
        // One is theoretical, other is numeric or fastest
        mode = 'lap_vs_theoretical';
      } else {
        // Both are numeric or one is fastest
        mode = 'lap_vs_lap';
      }
    }

    console.log(`🔧 Comparison mode: ${mode}`);

    // Build Python arguments
    const pythonArgs = [
      compareScript,
      '--mode', mode,
      '--file-a', tempFilePathA,
      '--cuts', trackCutsPath,
      '--output', outputDir
    ];

    // Add lap indices based on mode
    // For lap_vs_lap: need both lap-a and lap-b as numeric indices
    // For lap_vs_theoretical: need the NUMERIC lap as lap-a (theoretical is implied)
    // For fastest/theoretical modes: no lap indices needed
    
    if (mode === 'lap_vs_lap') {
      // Both must be numeric for this mode
      pythonArgs.push('--lap-a', String(lap_a_index));
      pythonArgs.push('--lap-b', String(lap_b_index));
    } else if (mode === 'lap_vs_theoretical') {
      // Pass the numeric lap (whichever one is NOT 'theoretical') as --lap-a
      if (lap_a_index !== 'theoretical' && lap_a_index !== 'fastest') {
        pythonArgs.push('--lap-a', String(lap_a_index));
      } else if (lap_b_index !== 'theoretical' && lap_b_index !== 'fastest') {
        pythonArgs.push('--lap-a', String(lap_b_index));
      }
      // Note: if both or neither are theoretical, something is wrong with mode detection
    }
    // For other modes (fastest_vs_theoretical, fastest_vs_fastest, theoretical_vs_theoretical),
    // no lap indices are needed

    // Add file B if cross-file
    if (tempFilePathB) {
      pythonArgs.push('--file-b', tempFilePathB);
      if (mode === 'lap_vs_lap' && lap_b_index !== 'fastest' && lap_b_index !== 'theoretical') {
        pythonArgs.push('--lap-b', lap_b_index);
      }
    }

    console.log(`🐍 Running compare_any.py with mode: ${mode}`);

    // Run Python script
    await new Promise((resolve, reject) => {
      const pythonProcess = spawn('py', pythonArgs, {
        env: { 
          ...process.env,
          PYTHONIOENCODING: 'utf-8' // Fix Windows encoding issues with Unicode characters
        }
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[Python] ${data.toString().trim()}`);
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[Python Error] ${data.toString().trim()}`);
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        } else {
          resolve();
        }
      });
    });

    console.log(`✅ Python script completed`);

    // Upload artifacts to Supabase Storage
    const reportId = crypto.randomUUID();
    const reportStoragePath = `reports/${reportId}`;

    // Upload ui_artifacts.json
    const uiArtifactsPath = path.join(outputDir, 'ui_artifacts.json');
    if (!fs.existsSync(uiArtifactsPath)) {
      throw new Error('ui_artifacts.json not generated by Python script');
    }

    const uiArtifactsBuffer = fs.readFileSync(uiArtifactsPath);
    const { error: uploadUIError } = await supabase.storage
      .from('telemetry-files')
      .upload(`${reportStoragePath}/ui_artifacts.json`, uiArtifactsBuffer, {
        contentType: 'application/json',
        upsert: true
      });

    if (uploadUIError) {
      throw new Error(`Failed to upload ui_artifacts.json: ${uploadUIError.message}`);
    }

    console.log(`✅ Uploaded ui_artifacts.json`);

    // Upload all plot images
    const plotFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
    for (const plotFile of plotFiles) {
      const plotPath = path.join(outputDir, plotFile);
      const plotBuffer = fs.readFileSync(plotPath);
      
      const { error: uploadPlotError } = await supabase.storage
        .from('telemetry-files')
        .upload(`${reportStoragePath}/${plotFile}`, plotBuffer, {
          contentType: 'image/png',
          upsert: true
        });

      if (uploadPlotError) {
        console.error(`⚠️ Failed to upload ${plotFile}:`, uploadPlotError);
      } else {
        console.log(`✅ Uploaded ${plotFile}`);
      }
    }

    // Create report record in database
    // Store comparison metadata in report_data JSON field
    const { error: reportError } = await supabase
      .from('reports')
      .insert({
        id: reportId,
        stint_id: stint_id,
        title: title,
        created_by: user.id,
        engineer_id: user.id,
        report_data: {
          notes: notes || null,
          lap_a_index: lap_a_index,
          lap_b_index: lap_b_index,
          ui_artifacts_path: `${reportStoragePath}/ui_artifacts.json`,
          comparison_data_path: `${reportStoragePath}/`,
          comparison_mode: mode,
          local_output_path: outputDir  // Store local path for serving artifacts
        }
      });

    if (reportError) {
      console.error('❌ Failed to create report record:', reportError);
      throw new Error(`Failed to create report: ${reportError.message}`);
    }

    // Auto-share report with drivers
    try {
      console.log('🔄 Auto-sharing report with drivers...');
      
      const shareWithDriver = async (stintData) => {
        if (!stintData || !stintData.car_id) return;

        // Get driver name from car
        const { data: carData, error: carError } = await supabase
          .from('cars')
          .select('driver_name')
          .eq('id', stintData.car_id)
          .single();

        if (carError || !carData || !carData.driver_name) {
          console.log(`⚠️ Could not find driver for car ${stintData.car_id}`);
          return;
        }

        const driverName = carData.driver_name;
        console.log(`👤 Found driver name: "${driverName}"`);

        // Find user by profile name
        // improved fuzzy matching or direct match
        const { data: profiles, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name')
          .ilike('full_name', driverName);

        if (profileError || !profiles || profiles.length === 0) {
          console.log(`⚠️ No user profile found for driver "${driverName}"`);
          return;
        }

        // Share with all matching profiles (usually just one)
        for (const profile of profiles) {
          const { error: shareError } = await supabase
            .from('report_shares')
            .insert({
              report_id: reportId,
              driver_id: profile.id
            })
            .select();

          if (shareError) {
            // Ignore unique constraint violations (already shared)
            if (shareError.code !== '23505') {
              console.error(`❌ Failed to share with ${profile.full_name}:`, shareError);
            } else {
              console.log(`ℹ️ Already shared with ${profile.full_name}`);
            }
          } else {
            console.log(`✅ Shared report with driver: ${profile.full_name}`);
          }
        }
      };

      // Share with Driver A
      await shareWithDriver(stintA);

      // Share with Driver B (if exists and different)
      if (stintB) {
        await shareWithDriver(stintB);
      }

    } catch (shareErr) {
      console.error('❌ Auto-share process failed:', shareErr);
      // Don't fail the request, just log it
    }

    console.log(`✅ Report created: ${reportId}`);

    // Clean up temp files
    // tempFiles.forEach(file => {
    //   if (fs.existsSync(file)) fs.unlinkSync(file);
    // });
    // if (fs.existsSync(tempDir)) {
    //   fs.rmSync(tempDir, { recursive: true, force: true });
    // }

    res.json({
      reportId,
      message: 'Report created successfully'
    });

  } catch (error) {
    console.error('❌ Report creation failed:', error);

    // Clean up temp files on error
    tempFiles.forEach(file => {
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (e) {}
      }
    });
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }

    res.status(500).json({ error: error.message });
  }
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// New endpoint to serve ui_artifacts.json from local file system
app.get('/api/reports/:reportId/artifacts', async (req, res) => {
  console.log('📊 Artifacts request for report:', req.params.reportId);
  
  try {
    // Authenticate user
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Fetch report to get storage path
    const { data: report, error: reportError } = await supabase
      .from('reports')
      .select('report_data')
      .eq('id', req.params.reportId)
      .single();

    if (reportError || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Prefer ui_artifacts_path, fallback to local path logic if strictly necessary (but we want to move away from it)
    const storagePath = report.report_data?.ui_artifacts_path;
    
    if (!storagePath) {
      console.error('❌ No ui_artifacts_path in report data');
      return res.status(404).json({ error: 'Artifacts path not found in report data' });
    }

    console.log(`☁️ Fetching artifacts from Supabase: ${storagePath}`);

    // Download from Supabase Storage
    const { data, error: downloadError } = await supabase.storage
      .from('telemetry-files')
      .download(storagePath);

    if (downloadError) {
      console.error(`❌ Failed to download artifacts:`, downloadError);
      return res.status(500).json({ error: 'Failed to download artifacts from storage' });
    }

    // Parse JSON from blob
    const textData = await data.text();
    const jsonData = JSON.parse(textData);
    
    res.json(jsonData);
    
    console.log(`✅ Served artifacts from storage`);

  } catch (error) {
    console.error('❌ Failed to serve artifacts:', error);
    res.status(500).json({ error: error.message });
  }
});

// app.post('/api/reports/create-v2', async (req, res) => {
//   console.log('📊 Report creation V2 request received');
  
//   try {
//     // 1. Authentication
//     const authHeader = req.headers.authorization;
//     if (!authHeader) {
//       return res.status(401).json({ error: 'No authorization header' });
//     }

//     const token = authHeader.replace('Bearer ', '');
//     const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
//     if (authError || !user) {
//       console.error('❌ Authentication failed:', authError);
//       return res.status(401).json({ error: 'Authentication failed' });
//     }

//     console.log(`✅ User authenticated: ${user.email}`);

//     // 2. Extract request parameters
//     const { 
//       stint_id,       // Primary stint (always required)
//       stint_b_id,     // Secondary stint (for multi-file modes)
//       mode,           // Comparison mode
//       lap_a_index,    // Lap A selection (optional based on mode)
//       lap_b_index,   // Lap B selection (optional based on mode)
//       title,
//       notes
//     } = req.body;

//     if (!stint_id || !mode || !title) {
//       return res.status(400).json({ error: 'Missing required fields: stint_id, mode, title' });
//     }

//     // 3. Load comparison modes configuration
//     const { COMPARISON_MODES } = require('./comparisonModes');
//     const modeConfig = COMPARISON_MODES[mode];
    
//     if (!modeConfig) {
//       return res.status(400).json({ 
//         error: `Invalid comparison mode: ${mode}`,
//         availableModes: Object.keys(COMPARISON_MODES)
//       });
//     }

//     console.log(`🔧 Mode: ${mode} (${modeConfig.description})`);

//     // 4. Validate required parameters for this mode
//     for (const param of modeConfig.required) {
//       if (req.body[param] === undefined || req.body[param] === null) {
//         return res.status(400).json({ 
//           error: `Missing required parameter for ${mode}: ${param}`,
//           required: modeConfig.required
//         });
//       }
//     }

//     // 5. Get stint A data with track info
//     const { data: stintA, error: stintAError } = await supabase
//       .from('stints')
//       .select(`
//         *,
//         track_sessions (
//           event_id,
//           events (
//             track_name
//           )
//         )
//       `)
//       .eq('id', stint_id)
//       .single();

//     if (stintAError || !stintA) {
//       console.error('❌ Stint A not found:', stintAError);
//       return res.status(404).json({ error: 'Stint not found' });
//     }

//     // 6. Get file paths from data folder
//     const telemetryKpiDir = path.join(__dirname, '..', '..', 'telemetry-kpi');
//     const dataPathA = stintA.metadata?.data_path || stintA.raw_file_path;
    
//     if (!dataPathA) {
//       return res.status(400).json({ error: 'Stint has no telemetry file path' });
//     }

//     const fileA = path.join(telemetryKpiDir, dataPathA);
    
//     if (!fs.existsSync(fileA)) {
//       console.error(`❌ File A not found: ${fileA}`);
//       return res.status(404).json({ error: 'Telemetry file A not found in data folder' });
//     }

//     console.log(`📁 File A: ${dataPathA}`);

//     // 7. Get stint B and file B if multi-file mode
//     let fileB = null;
//     let stintB = null;

//     if (modeConfig.multiFile && stint_b_id) {
//       const { data: stintBData, error: stintBError } = await supabase
//         .from('stints')
//         .select('*, metadata')
//         .eq('id', stint_b_id)
//         .single();

//       if (stintBError || !stintBData) {
//         console.error('❌ Stint B not found:', stintBError);
//         return res.status(404).json({ error: 'Stint B not found' });
//       }

//       stintB = stintBData;
//       const dataPathB = stintB.metadata?.data_path || stintB.raw_file_path;
      
//       if (!dataPathB) {
//         return res.status(400).json({ error: 'Stint B has no telemetry file path' });
//       }

//       fileB = path.join(telemetryKpiDir, dataPathB);
      
//       if (!fs.existsSync(fileB)) {
//         console.error(`❌ File B not found: ${fileB}`);
//         return res.status(404).json({ error: 'Telemetry file B not found in data folder' });
//       }

//       console.log(`📁 File B: ${dataPathB}`);
//     }

//     // 8. Get track cuts
//     const trackName = stintA.track_sessions?.events?.track_name || 'brands_hatch';
//     const trackSlug = normalizeTrackName(trackName);
//     const cutsPath = path.join(telemetryKpiDir, 'track_cuts', `${trackSlug}_cuts.json`);

//     if (!fs.existsSync(cutsPath)) {
//       const trackCutsDir = path.join(telemetryKpiDir, 'track_cuts');
//       const availableCuts = fs.existsSync(trackCutsDir) 
//         ? fs.readdirSync(trackCutsDir).filter(f => f.endsWith('_cuts.json'))
//         : [];
      
//       console.error(`❌ Track cuts not found: ${cutsPath}`);
//       return res.status(400).json({ 
//         error: `Track configuration not found for "${trackName}"`,
//         availableTracks: availableCuts.map(f => f.replace('_cuts.json', ''))
//       });
//     }

//     console.log(`📍 Track: ${trackName} (${trackSlug})`);

//     // 9. Setup output directory
//     const reportId = crypto.randomUUID();
//     const outputName = `report_${reportId}`;
//     const outputDir = path.join(telemetryKpiDir, 'results', outputName);

//     // 10. Build CLI command
//     const compareScript = path.join(telemetryKpiDir, 'compare_any.py');
//     const cliArgs = [
//       compareScript,
//       '--mode', modeConfig.cliMode,
//       '--file-a', fileA,
//       '--cuts', cutsPath,
//       '--output', outputDir
//     ];

//     // Add file B for multi-file modes
//     if (modeConfig.multiFile && fileB) {
//       cliArgs.push('--file-b', fileB);
//     }

//     // Add lap indices based on mode requirements
//     if (lap_a_index !== undefined && lap_a_index !== null) {
//       cliArgs.push('--lap-a', lap_a_index.toString());
//     }

//     if (lap_b_index !== undefined && lap_b_index !== null) {
//       cliArgs.push('--lap-b', lap_b_index.toString());
//     }

//     console.log('🐍 CLI Command:', cliArgs.join(' '));

//     // 11. Execute Python script
//     await new Promise((resolve, reject) => {
//       const pythonProcess = spawn('py', cliArgs, {
//         cwd: telemetryKpiDir,
//         env: { 
//           ...process.env,
//           PYTHONIOENCODING: 'utf-8'
//         }
//       });

//       let stdout = '';
//       let stderr = '';

//       pythonProcess.stdout.on('data', (data) => {
//         stdout += data.toString();
//         console.log(`[Python] ${data.toString().trim()}`);
//       });

//       pythonProcess.stderr.on('data', (data) => {
//         stderr += data.toString();
//         console.error(`[Python Error] ${data.toString().trim()}`);
//       });

//       pythonProcess.on('close', (code) => {
//         if (code !== 0) {
//           reject(new Error(`Python script failed with code ${code}: ${stderr}`));
//         } else {
//           resolve();
//         }
//       });

//       pythonProcess.on('error', (err) => {
//         reject(new Error(`Failed to start Python: ${err.message}`));
//       });

//       // Timeout after 2 minutes
//       setTimeout(() => {
//         pythonProcess.kill();
//         reject(new Error('Python script timeout (2 minutes)'));
//       }, 120000);
//     });

//     console.log('✅ Python script completed');

//     // 12. Upload ui_artifacts.json to Supabase Storage
//     const uiArtifactsPath = path.join(outputDir, 'ui_artifacts.json');
    
//     if (!fs.existsSync(uiArtifactsPath)) {
//       console.warn('⚠️ ui_artifacts.json not found, skipping upload');
//     } else {
//       const uiArtifactsData = fs.readFileSync(uiArtifactsPath);
//       const storagePath = `reports/${reportId}/ui_artifacts.json`;
      
//       const { error: uploadError } = await supabase.storage
//         .from('telemetry-reports')
//         .upload(storagePath, uiArtifactsData, {
//           contentType: 'application/json',
//           upsert: true
//         });

//       if (uploadError) {
//         console.error('❌ Failed to upload ui_artifacts.json:', uploadError);
//       } else {
//         console.log(`☁️ Uploaded to: ${storagePath}`);
//       }
//     }

//     // 13. Create report record in database
//     const { data: report, error: dbError } = await supabase
//       .from('reports')
//       .insert({
//         id: reportId,
//         stint_id: stint_id,
//         engineer_id: user.id,
//         title: title,
//         report_data: {
//           mode: mode,
//           stint_b_id: stint_b_id || null,
//           lap_a_index: lap_a_index || null,
//           lap_b_index: lap_b_index || null,
//           results_path: `results/${outputName}`,
//           ui_artifacts_path: `reports/${reportId}/ui_artifacts.json`,
//           notes: notes || null,
//           track_name: trackName,
//           created_at: new Date().toISOString()
//         }
//       })
//       .select()
//       .single();

//     if (dbError) {
//       console.error('❌ Failed to create report record:', dbError);
//       return res.status(500).json({ error: 'Failed to save report', details: dbError.message });
//     }

//     console.log(`✅ Report created: ${reportId}`);

//     res.json({
//       success: true,
//       report_id: reportId,
//       ui_artifacts_path: `reports/${reportId}/ui_artifacts.json`,
//       message: 'Report created successfully'
//     });

//   } catch (error) {
//     console.error('❌ Report creation V2 failed:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

app.listen(PORT, () => {
  console.log(`🚀 Upload server running on http://localhost:${PORT}`);
  console.log(`📊 Max file size: 500 MB`);
  console.log(`🔗 Accepting requests from: http://localhost:8080, http://localhost:5173`);
});
