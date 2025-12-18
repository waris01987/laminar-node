const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

async function checkEvents() {
  console.log('📊 Fetching events...\n');
  
  const { data, error } = await supabase
    .from('events')
    .select('id, name, track_name')
    .limit(10);
  
  if (error) {
    console.error('❌ Error:', error);
    return;
  }
  
  console.log('Events in database:');
  console.log(JSON.stringify(data, null, 2));
  
  console.log('\n📍 Track names found:');
  data.forEach(event => {
    const trackSlug = (event.track_name || 'unknown').replace(/\s+/g, '_').toLowerCase();
    console.log(`  - ${event.name}: "${event.track_name}" → ${trackSlug}_cuts.json`);
  });
}

checkEvents();
