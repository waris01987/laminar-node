// MODE CONFIGURATION for all 8 comparison types
const COMPARISON_MODES = {
  // Single file modes
  'lap_vs_lap': {
    multiFile: false,
    required: ['lap_a_index', 'lap_b_index'],
    cliMode: 'lap_vs_lap',
    description: 'Compare two specific laps from same session'
  },
  'fastest_vs_theoretical': {
    multiFile: false,
    required: [],
    cliMode: 'fastest_vs_theoretical_same_file',
    description: 'Compare fastest lap vs theoretical best from same session'
  },
  'lap_vs_theoretical': {
    multiFile: false,
    required: ['lap_a_index'],
    cliMode: 'lap_vs_theoretical',
    description: 'Compare specific lap vs theoretical best from same session'
  },
  // Multi-file modes
  'lap_vs_lap_multi': {
    multiFile: true,
    required: ['stint_b_id', 'lap_a_index', 'lap_b_index'],
    cliMode: 'lap_vs_lap',
    description: 'Compare two specific laps from different sessions'
  },
  'fastest_vs_fastest': {
    multiFile: true,
    required: ['stint_b_id'],
    cliMode: 'fastest_vs_fastest',
    description: 'Compare fastest laps from two sessions'
  },
  'fastest_vs_theoretical_multi': {
    multiFile: true,
    required: ['stint_b_id'],
    cliMode: 'fastest_vs_theoretical',
    description: 'Compare fastest lap from session A vs theoretical from session B'
  },
  'theoretical_vs_theoretical': {
    multiFile: true,
    required: ['stint_b_id'],
    cliMode: 'theoretical_vs_theoretical',
    description: 'Compare theoretical bests from two sessions'
  },
  'lap_vs_theoretical_multi': {
    multiFile: true,
    required: ['stint_b_id', 'lap_a_index'],
    cliMode: 'lap_vs_theoretical',
    description: 'Compare specific lap from session A vs theoretical from session B'
  }
};

module.exports = { COMPARISON_MODES };
