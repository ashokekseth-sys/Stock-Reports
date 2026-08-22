/* Deployment configuration: thresholds, confidence weights, escalation policy,
   retention. Everything here is editable at runtime from the Settings view and
   persisted per deployment/region — nothing about escalation is hardcoded. */
(function (FF) {
  'use strict';

  /* Grid origin: Rajaji-style reserve terrain, ~100 m node spacing. */
  const DEPLOYMENT = {
    id: 'rjj-north',
    name: 'Rajaji North Range',
    origin: { lat: 30.4520, lng: 78.0850 },
    cols: 10,
    rows: 6,
    spacingM: 100,
    /* A gateway is placed every 3 grids where Wi-Fi/cellular backhaul exists. */
    gatewayEvery: 3
  };

  const DEFAULT_CONFIG = {
    deploymentId: DEPLOYMENT.id,
    regionName: DEPLOYMENT.name,

    /* Sensor thresholds. MQ135 reports a CO2-equivalent air-quality figure;
       smoke and combustion volatiles push it well above the forest baseline. */
    thresholds: {
      gasPpm: 720,        // MQ135 CO2-equivalent ppm
      gasRatePpmPerMin: 45, // rapid-rise trigger even below the absolute level
      tempC: 42,          // canopy-level air temperature
      humidityPct: 22     // breach when humidity falls BELOW this
    },

    /* Confidence scoring weights (must total 100). See alerts.js for the
       formula; exposed here so a range can tune it without a code change. */
    confidence: {
      wMetrics: 35,      // how many of gas/temp/humidity breached at once
      wNeighbors: 40,    // corroboration from adjacent nodes
      wSeverity: 15,     // how far past threshold the worst metric is
      wPersistence: 10,  // sustained across consecutive transmissions
      neighborsForFull: 2,   // neighbours needed to max the corroboration term
      persistenceSamples: 3, // samples needed to max the persistence term
      tiers: { critical: 80, high: 60, moderate: 40 } // below moderate => low
    },

    /* Neighbour correlation. Nodes sit on a 100 m grid, so a 160 m radius
       catches the 4-neighbourhood plus diagonals at 141 m. */
    correlation: {
      radiusM: 160,
      windowMin: 12,       // spikes within this window count as simultaneous
      minClusterSize: 2    // 2+ adjacent nodes => cluster alert
    },

    /* Escalation policy — configurable per deployment, never hardcoded. */
    escalation: {
      enabled: true,
      timeoutMin: 10,           // unacknowledged for this long => escalate
      criticalTimeoutMin: 4,    // critical tier escalates faster
      minTierToEscalate: 'moderate',
      channels: { push: true, sms: true, voice: true },
      contacts: [
        { id: 'c1', name: 'Range Forest Officer — R. Bhatt', phone: '+91 90000 11111', channel: 'sms',   order: 1 },
        { id: 'c2', name: 'Fire Watch Control Room',         phone: '+91 90000 22222', channel: 'voice', order: 2 },
        { id: 'c3', name: 'Divisional FO (on-call)',         phone: '+91 90000 33333', channel: 'sms',   order: 3 }
      ]
    },

    /* Retention. Alert history and the feedback-tagged dataset age out
       separately — labelled data is worth keeping longer for model tuning. */
    retention: {
      alertHistoryDays: 365,
      feedbackDatasetDays: 730,
      telemetryHours: 72
    },

    /* Node health. */
    health: {
      offlineAfterMin: 15,      // no packet in this long => offline
      batteryLowPct: 30,
      batteryCriticalPct: 15
    },

    notifications: { browserPush: true, inAppToast: true, minTier: 'moderate' }
  };

  const OUTCOME_TAGS = [
    { id: 'confirmed_fire',   label: 'Confirmed fire',      desc: 'Real ignition verified on the ground.',        truePositive: true  },
    { id: 'controlled_burn',  label: 'Controlled burn',     desc: 'Planned or permitted burn in the compartment.', truePositive: false },
    { id: 'animal_activity',  label: 'Animal activity',     desc: 'Node disturbed by wildlife; readings spurious.', truePositive: false },
    { id: 'sensor_fault',     label: 'Sensor fault',        desc: 'Drifting or failed MQ135 / DHT element.',        truePositive: false },
    { id: 'dust_haze',        label: 'Dust / external haze', desc: 'Road dust, crop-residue smoke drifting in.',    truePositive: false },
    { id: 'other',            label: 'Other / unresolved',  desc: 'Inspected, cause not established.',             truePositive: false }
  ];

  const TIERS = ['low', 'moderate', 'high', 'critical'];
  const TIER_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

  const RISK_LEVELS = [
    { id: 'normal',   label: 'Normal',   min: 0,  color: '#3fbf7f' },
    { id: 'elevated', label: 'Elevated', min: 30, color: '#ffc748' },
    { id: 'high',     label: 'High',     min: 55, color: '#ff8a3d' },
    { id: 'critical', label: 'Critical', min: 78, color: '#ff4d4d' }
  ];

  function riskLevel(score) {
    let out = RISK_LEVELS[0];
    for (let i = 0; i < RISK_LEVELS.length; i++) if (score >= RISK_LEVELS[i].min) out = RISK_LEVELS[i];
    return out;
  }

  function tierColor(tier) {
    return { critical: '#ff4d4d', high: '#ff8a3d', moderate: '#ffc748', low: '#4c9aff' }[tier] || '#6b7f92';
  }

  /* Demo accounts. Client-side only — this is a field-console prototype, not
     an authentication system. Swap for the range's SSO before deployment. */
  const USERS = [
    { username: 'ranger',  password: 'forest123', name: 'A. Negi',   role: 'Forest Ranger',        beat: 'Kansrao Beat' },
    { username: 'officer', password: 'forest123', name: 'R. Bhatt',  role: 'Range Forest Officer', beat: 'Rajaji North' },
    { username: 'watch',   password: 'forest123', name: 'S. Kumar',  role: 'Fire Watcher',         beat: 'Motichur Beat' }
  ];

  FF.config = {
    DEPLOYMENT: DEPLOYMENT,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    OUTCOME_TAGS: OUTCOME_TAGS,
    TIERS: TIERS,
    TIER_RANK: TIER_RANK,
    RISK_LEVELS: RISK_LEVELS,
    USERS: USERS,
    riskLevel: riskLevel,
    tierColor: tierColor
  };
})(window.FF = window.FF || {});
