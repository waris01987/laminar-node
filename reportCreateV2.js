// // NEW REPORT CREATION ENDPOINT - V2 with All Comparison Modes
// // To be added to server/index.js before app.listen()

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
