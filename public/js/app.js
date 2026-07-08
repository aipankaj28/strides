// State Management
const state = {
  currentUser: null,
  activeView: 'gate',
  cart: {
    activity_type: 'run',
    activity_tier: null,
    activity_distance: '5k'
  },
  activeTab: 'leaderboard',
  leaderboardCategory: 'run',
  activeDevTab: 'dev-users',
  devDrawerOpen: false,
  dashboardPollSeconds: 15,
  dashboardPollTimer: null,
  eventStartDate: '2026-07-26',
  resetPasswordEmail: null,
  adminSecret: null,
  adminExpandedUserId: null,
  adminActivitiesCache: {}
};

// Formats a YYYY-MM-DD date string as "26th July 2026" for display text
function formatEventDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  const suffix = (day % 10 === 1 && day !== 11) ? 'st'
    : (day % 10 === 2 && day !== 12) ? 'nd'
    : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

// Tier -> distance option lookup for Run/Cycle (Mix has no tiers)
const TIER_DISTANCE_OPTIONS = {
  run: {
    pro: [{ value: '21k', label: '21K (Half Marathon)' }, { value: '15k', label: '15K' }],
    intermediate: [{ value: '10k', label: '10K' }, { value: '7k', label: '7K' }],
    beginner: [{ value: '5k', label: '5K' }, { value: '2k', label: '2K' }]
  },
  cycle: {
    pro: [{ value: '50k', label: '50K' }, { value: '40k', label: '40K' }],
    intermediate: [{ value: '30k', label: '30K' }],
    beginner: [{ value: '10k', label: '10K' }, { value: '20k', label: '20K' }]
  }
};

// Flexi tier = any distance above this daily minimum (no fixed list)
const FLEXI_MIN_KM = { run: 2, cycle: 10 };

// Icon + label per Strava activity type (lowercased, spaces/hyphens stripped).
// Covers the types relevant to Run/Cycle/Mix plus common others a synced
// Strava account might log (swim, hike, workout, etc.) so nothing gets
// silently mislabeled as a type it isn't.
const ACTIVITY_TYPE_DISPLAY = {
  run: { icon: 'fa-person-running', label: 'Run' },
  trailrun: { icon: 'fa-person-running', label: 'Trail Run' },
  walk: { icon: 'fa-person-walking', label: 'Walk' },
  hike: { icon: 'fa-person-hiking', label: 'Hike' },
  ride: { icon: 'fa-bicycle', label: 'Ride' },
  virtualride: { icon: 'fa-bicycle', label: 'Virtual Ride' },
  mountainbikeride: { icon: 'fa-bicycle', label: 'Mountain Bike' },
  gravelride: { icon: 'fa-bicycle', label: 'Gravel Ride' },
  ebikeride: { icon: 'fa-bicycle', label: 'E-Bike Ride' },
  handcycle: { icon: 'fa-wheelchair-move', label: 'Handcycle' },
  swim: { icon: 'fa-person-swimming', label: 'Swim' },
  workout: { icon: 'fa-dumbbell', label: 'Workout' },
  weighttraining: { icon: 'fa-dumbbell', label: 'Weight Training' },
  crossfit: { icon: 'fa-dumbbell', label: 'CrossFit' },
  yoga: { icon: 'fa-spa', label: 'Yoga' },
  rowing: { icon: 'fa-water', label: 'Rowing' },
  kayaking: { icon: 'fa-water', label: 'Kayaking' },
  standuppaddling: { icon: 'fa-water', label: 'Paddling' },
  surfing: { icon: 'fa-water', label: 'Surfing' },
  alpineski: { icon: 'fa-person-skiing', label: 'Alpine Ski' },
  nordicski: { icon: 'fa-person-skiing-nordic', label: 'Nordic Ski' },
  snowboard: { icon: 'fa-person-snowboarding', label: 'Snowboard' },
  iceskate: { icon: 'fa-person-skating', label: 'Ice Skate' },
  wheelchair: { icon: 'fa-wheelchair-move', label: 'Wheelchair' }
};

// Looks up the icon/label for a raw Strava activity type string, falling
// back to a generic stopwatch icon + the raw type name for anything not
// explicitly mapped above (e.g. Golf, Tennis, RockClimbing).
function getActivityDisplay(rawType) {
  const key = (rawType || '').toLowerCase().replace(/[\s_-]/g, '');
  const match = ACTIVITY_TYPE_DISPLAY[key];
  if (match) return match;
  const fallbackLabel = rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1) : 'Activity';
  return { icon: 'fa-stopwatch', label: fallbackLabel };
}

// Formatting Helpers
function formatTime(seconds) {
  if (isNaN(seconds) || seconds <= 0) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [
    String(hrs).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].join(':');
}

function formatSpeed(speedKms) {
  // Convert km/s to km/h
  const speedKmh = parseFloat(speedKms) * 3600;
  return speedKmh.toFixed(2) + ' km/h';
}

// Client Routing & Views Switching
const app = {
  async init() {
    this.bindEvents();
    this.checkSession();
    this.handleHashRoute();
    window.addEventListener('hashchange', () => this.handleHashRoute());

    // Check configuration for Dev Mode from the backend config API
    try {
      const configRes = await fetch('/api/config');
      const config = await configRes.json();
      state.devMode = config.devMode;
      state.dashboardPollSeconds = config.dashboardPollSeconds || 15;
      state.eventStartDate = config.eventStartDate || '2026-07-26';
      this.applyEventStartDate();
      const devDrawer = document.getElementById('dev-drawer');
      if (devDrawer) {
        if (config.devMode) {
          devDrawer.style.display = 'block';
        } else {
          devDrawer.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('Failed to load application configuration:', err);
      state.devMode = false;
      this.applyEventStartDate();
      const devDrawer = document.getElementById('dev-drawer');
      if (devDrawer) devDrawer.style.display = 'none';
    }

    // Periodically sync developer dashboard indicators if open and dev mode is enabled
    setInterval(() => {
      if (state.devDrawerOpen && state.devMode) {
        this.loadDevData();
      }
    }, 5000);

    // Pause/resume dashboard polling when the tab is hidden/shown, so we
    // don't keep hitting the server while the user isn't looking at it.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopDashboardPolling();
      } else if (state.activeView === 'dashboard') {
        this.startDashboardPolling();
      }
    });
  },

  // Polls the dashboard data on an interval while the Athlete Dashboard
  // view is open, so Strava webhook updates (which land in the database
  // instantly) show up without the user manually clicking "Sync Activities".
  startDashboardPolling() {
    this.stopDashboardPolling();
    const intervalMs = Math.max(1, state.dashboardPollSeconds) * 1000;
    state.dashboardPollTimer = setInterval(() => {
      if (state.activeView === 'dashboard' && state.currentUser) {
        this.loadDashboard();
      }
    }, intervalMs);
  },

  stopDashboardPolling() {
    if (state.dashboardPollTimer) {
      clearInterval(state.dashboardPollTimer);
      state.dashboardPollTimer = null;
    }
  },

  bindEvents() {
    // Password match feedback listener
    const pwdInput = document.getElementById('signup-password');
    const confirmInput = document.getElementById('signup-password-confirm');
    const feedback = document.getElementById('password-match-feedback');

    const updateFeedback = () => {
      const pwd = pwdInput.value;
      const confirm = confirmInput.value;
      if (!pwd || !confirm) {
        feedback.style.display = 'none';
        return;
      }
      feedback.style.display = 'block';
      if (pwd === confirm) {
        feedback.style.color = 'var(--success)';
        feedback.innerHTML = '<i class="fa-solid fa-circle-check"></i> Passwords match';
      } else {
        feedback.style.color = 'var(--danger)';
        feedback.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Passwords do not match';
      }
    };
    if (pwdInput && confirmInput && feedback) {
      pwdInput.addEventListener('input', updateFeedback);
      confirmInput.addEventListener('input', updateFeedback);
    }

    // Signup Form Handler
    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('signup-name').value;
      const surname = document.getElementById('signup-surname').value;
      const email = document.getElementById('signup-email').value;
      const mobile = document.getElementById('signup-mobile').value;
      const password = document.getElementById('signup-password').value;
      const passwordConfirm = document.getElementById('signup-password-confirm').value;

      if (password !== passwordConfirm) {
        alert('Passwords do not match.');
        return;
      }

      // Strong password validation rules
      const hasUppercase = /[A-Z]/.test(password);
      const hasLowercase = /[a-z]/.test(password);
      const hasNumber = /[0-9]/.test(password);
      const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

      if (password.length < 8 || !hasUppercase || !hasLowercase || !hasNumber || !hasSpecial) {
        alert('Password does not meet strength requirements. It must be at least 8 characters long and contain uppercase, lowercase, numbers, and special characters.');
        return;
      }

      try {
        const res = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, surname, email, mobile, password })
        });
        const data = await res.json();
        
        if (!res.ok) {
          alert(data.error || 'Registration failed.');
          return;
        }

        state.currentUser = data;
        localStorage.setItem('athlete_email', data.email);
        this.switchView('cart');
      } catch (err) {
        console.error(err);
        alert('Connection error registering profile.');
      }
    });

    // Login Form Handler
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (!res.ok) {
          alert(data.error || 'Login failed.');
          return;
        }

        state.currentUser = data;
        localStorage.setItem('athlete_email', data.email);
        this.routeUserByStatus();
      } catch (err) {
        console.error(err);
        alert('Connection error logging in.');
      }
    });

    // Forgot Password Form Handler — requests an OTP be emailed to the given address
    document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-password-email').value.trim();
      const errorEl = document.getElementById('forgot-password-error');
      errorEl.style.display = 'none';

      try {
        const res = await fetch('/api/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (!res.ok) {
          errorEl.textContent = data.error || 'Something went wrong. Please try again.';
          errorEl.style.display = 'block';
          return;
        }

        state.resetPasswordEmail = email;
        document.getElementById('reset-password-email-display').textContent = email;
        this.switchView('reset-password');
      } catch (err) {
        console.error(err);
        errorEl.textContent = 'Connection error sending verification code.';
        errorEl.style.display = 'block';
      }
    });

    // Reset Password Form Handler — verifies the OTP and sets the new password
    document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const otp = document.getElementById('reset-password-otp').value.trim();
      const newPassword = document.getElementById('reset-password-new').value;
      const confirmPassword = document.getElementById('reset-password-confirm').value;
      const errorEl = document.getElementById('reset-password-error');
      errorEl.style.display = 'none';

      if (newPassword !== confirmPassword) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: state.resetPasswordEmail, otp, newPassword })
        });
        const data = await res.json();

        if (!res.ok) {
          errorEl.textContent = data.error || 'Could not reset password.';
          errorEl.style.display = 'block';
          return;
        }

        alert('Password reset successfully. Please log in with your new password.');
        document.getElementById('login-email').value = state.resetPasswordEmail;
        state.resetPasswordEmail = null;
        this.switchView('login');
      } catch (err) {
        console.error(err);
        errorEl.textContent = 'Connection error resetting password.';
        errorEl.style.display = 'block';
      }
    });

    // Admin Login Form Handler — verifies the password by attempting the
    // actual data fetch; a real ADMIN_SECRET mismatch surfaces as a 401.
    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const secret = document.getElementById('admin-secret-input').value;
      const errorEl = document.getElementById('admin-login-error');
      errorEl.style.display = 'none';

      try {
        const res = await fetch('/api/admin/dashboard-users', {
          headers: { 'x-admin-secret': secret }
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          errorEl.textContent = data.error || 'Incorrect admin password.';
          errorEl.style.display = 'block';
          return;
        }

        state.adminSecret = secret;
        sessionStorage.setItem('admin_secret', secret);
        this.switchView('admin-dashboard');
      } catch (err) {
        console.error(err);
        errorEl.textContent = 'Connection error logging in.';
        errorEl.style.display = 'block';
      }
    });

    // Cart Submission Handler — confirms the category/distance selection
    // (no payment is collected) and moves straight to the mandatory Strava step
    document.getElementById('cart-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: state.currentUser.id,
            activity_type: state.cart.activity_type,
            activity_tier: state.cart.activity_tier,
            activity_distance: state.cart.activity_distance
          })
        });
        const data = await res.json();

        if (!res.ok) {
          alert(data.error || 'Could not save your selection.');
          return;
        }

        state.currentUser = data;
        this.switchView('connect-strava');
      } catch (err) {
        console.error(err);
        alert('Connection error saving your selection.');
      }
    });

    // Logout Button
    document.getElementById('logout-btn').addEventListener('click', () => {
      state.currentUser = null;
      localStorage.removeItem('athlete_email');
      document.getElementById('logout-btn').style.display = 'none';
      this.switchView('gate');
    });
  },

  checkSession() {
    const savedEmail = localStorage.getItem('athlete_email');
    if (savedEmail) {
      // Pre-fill login
      document.getElementById('login-email').value = savedEmail;
    }
    // Admin session is stored separately (sessionStorage — cleared when the
    // tab closes) since it's a shared password, not a personal login.
    const savedAdminSecret = sessionStorage.getItem('admin_secret');
    if (savedAdminSecret) {
      state.adminSecret = savedAdminSecret;
    }
  },

  // Pushes the configurable event start date into every static display spot
  // and the dev simulator's default activity-date input.
  applyEventStartDate() {
    const formatted = formatEventDate(state.eventStartDate);
    const connectStravaEl = document.getElementById('connect-strava-event-date');
    if (connectStravaEl) connectStravaEl.textContent = formatted;

    const activityLogsEl = document.getElementById('activity-logs-event-date');
    if (activityLogsEl) activityLogsEl.textContent = formatted;

    const mockDateLabelEl = document.getElementById('mock-act-date-label');
    if (mockDateLabelEl) mockDateLabelEl.textContent = state.eventStartDate;

    const mockDateInput = document.getElementById('mock-act-date');
    if (mockDateInput) mockDateInput.value = state.eventStartDate;
  },

  handleHashRoute() {
    const hash = window.location.hash || '#/gate';
    
    // Auth redirect callback check (hash routes /connect-strava?email=...)
    if (hash.includes('/connect-strava')) {
      const emailMatch = hash.match(/email=([^&]+)/);
      const errorMatch = hash.match(/error=([^&]+)/);
      if (emailMatch) {
        const email = decodeURIComponent(emailMatch[1]);
        const errorMsg = errorMatch ? decodeURIComponent(errorMatch[1]) : null;
        this.autoLoginByEmail(email, 'connect-strava').then(() => {
          if (errorMsg) {
            alert(`Strava authorization was not completed: ${errorMsg}. Please try again.`);
          }
          // Clean up the URL so the email is not visible in the address bar
          history.replaceState(null, '', '#/connect-strava');
        });
        return;
      }
    }

    if (hash.includes('/dashboard')) {
      const emailMatch = hash.match(/email=([^&]+)/);
      if (emailMatch) {
        const email = decodeURIComponent(emailMatch[1]);
        this.autoLoginByEmail(email, 'dashboard').then(() => {
          // Clean up the URL so the email is not visible in the address bar
          history.replaceState(null, '', '#/dashboard');
        });
        return;
      }
      if (state.currentUser) {
        this.switchView('dashboard');
        return;
      }
    }

    const cleanHash = hash.split('?')[0];
    if (cleanHash === '#/gate') this.switchView('gate');
    else if (cleanHash === '#/login') this.switchView('login');
    else if (cleanHash === '#/forgot-password') this.switchView('forgot-password');
    else if (cleanHash === '#/reset-password' && state.resetPasswordEmail) this.switchView('reset-password');
    else if (cleanHash === '#/admin-login') this.switchView('admin-login');
    else if (cleanHash === '#/admin-dashboard' && state.adminSecret) this.switchView('admin-dashboard');
    else if (cleanHash === '#/privacy-policy') this.switchView('privacy-policy');
    else if (cleanHash === '#/terms-of-service') this.switchView('terms-of-service');
    else if (cleanHash === '#/signup') this.switchView('signup');
    else if (cleanHash === '#/cart' && state.currentUser) this.switchView('cart');
    else if (cleanHash === '#/connect-strava' && state.currentUser) this.switchView('connect-strava');
    else if (cleanHash === '#/dashboard' && state.currentUser) this.switchView('dashboard');
    else {
      // Fallback
      window.location.hash = '#/gate';
    }
  },

  async autoLoginByEmail(email, targetView) {
    try {
      // Restore session using the dashboard profile endpoint (no password needed).
      // This is used exclusively after OAuth callbacks where the server has already
      // authenticated the user and placed their email in the redirect URL.
      const res = await fetch(`/api/user/dashboard?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        const data = await res.json();
        state.currentUser = data.user;
        localStorage.setItem('athlete_email', email);
        this.switchView(targetView);
      } else {
        window.location.hash = '#/gate';
      }
    } catch (e) {
      window.location.hash = '#/gate';
    }
  },

  routeUserByStatus() {
    const user = state.currentUser;
    if (!user) {
      this.switchView('gate');
      return;
    }

    // is_paid is repurposed to mean "category/distance selection confirmed"
    // now that no payment is collected. Strava connection is mandatory.
    if (!user.is_paid) {
      this.switchView('cart');
    } else if (!user.strava_access_token) {
      this.switchView('connect-strava');
    } else {
      this.switchView('dashboard');
    }
  },

  switchView(viewName) {
    // Strava connection is mandatory — never let the dashboard render
    // without it, regardless of how this view was reached (hash route,
    // OAuth redirect, manual navigation, etc.)
    if (viewName === 'dashboard' && state.currentUser && !state.currentUser.strava_access_token) {
      viewName = 'connect-strava';
    }

    state.activeView = viewName;

    // Close mobile profile sidebar if open
    const sidebar = document.getElementById('profile-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar && backdrop) {
      sidebar.classList.remove('open');
      backdrop.classList.remove('active');
    }
    
    // Hide all views, show active
    document.querySelectorAll('.view-section').forEach(sect => {
      sect.classList.remove('active');
    });

    const activeSect = document.getElementById(`view-${viewName}`);
    if (activeSect) {
      activeSect.classList.add('active');
    }

    // Toggle Logout Button visibility
    const showLogout = ['cart', 'connect-strava', 'dashboard'].includes(viewName);
    document.getElementById('logout-btn').style.display = showLogout ? 'block' : 'none';

    // Header profile/Strava toggle is only relevant on the dashboard (CSS hides it on desktop)
    document.getElementById('header-profile-btn').style.display = viewName === 'dashboard' ? 'flex' : 'none';

    // Synchronize browser history hash representation
    if (window.location.hash.split('?')[0] !== `#/${viewName}`) {
      window.location.hash = `#/${viewName}`;
    }

    // Run view lifecycle renders
    if (viewName === 'cart') {
      this.stopDashboardPolling();
      this.selectCategory(state.cart.activity_type || 'run');
    } else if (viewName === 'dashboard') {
      this.loadDashboard();
      this.startDashboardPolling();
    } else if (viewName === 'admin-dashboard') {
      this.stopDashboardPolling();
      this.loadAdminUsers();
    } else {
      this.stopDashboardPolling();
    }

    if (state.devDrawerOpen) {
      this.loadDevData();
    }
  },

  toggleProfileSidebar() {
    const sidebar = document.getElementById('profile-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar && backdrop) {
      const isOpen = sidebar.classList.contains('open');
      if (isOpen) {
        sidebar.classList.remove('open');
        backdrop.classList.remove('active');
      } else {
        sidebar.classList.add('open');
        backdrop.classList.add('active');
      }
    }
  },

  // ---------------------------------------------------------
  // CART / EVENT SELECTION CONTROLLERS
  // ---------------------------------------------------------

  selectCategory(cat) {
    state.cart.activity_type = cat;
    state.cart.activity_tier = null;

    // Remove selected style classes and disable every select inside every card
    document.querySelectorAll('.category-card').forEach(card => {
      card.classList.remove('selected');
      card.querySelectorAll('select').forEach(sel => {
        sel.disabled = true;
        const hasBlank = Array.from(sel.options).some(opt => opt.value === "");
        if (hasBlank) sel.value = "";
      });
    });

    // Hide all Flexi custom-distance containers by default
    ['run', 'cycle'].forEach(c => {
      const container = document.getElementById(`custom-dist-${c}-container`);
      if (container) container.style.display = 'none';
    });

    // Highlight selected card
    const selectedCard = document.getElementById(`card-${cat}`);
    selectedCard.classList.add('selected');

    if (cat === 'mix') {
      // Mix has no tier and no distance requirement at all
      state.cart.activity_distance = null;
    } else {
      // Run / Cycle: enable the tier select and default to Pro
      const tierSelect = document.getElementById(`select-tier-${cat}`);
      if (tierSelect) {
        tierSelect.disabled = false;
        tierSelect.value = 'pro';
        this.onTierChange(cat);
      }
    }

    this.validateCartSelection();
  },

  // Rebuilds the distance select's options based on the chosen tier (Pro/Intermediate/
  // Beginner), or switches to the free-entry Flexi input when tier === 'flexi'.
  onTierChange(cat) {
    const tierSelect = document.getElementById(`select-tier-${cat}`);
    const tier = tierSelect.value;
    state.cart.activity_tier = tier;

    const distSelect = document.getElementById(`select-dist-${cat}`);
    const customContainer = document.getElementById(`custom-dist-${cat}-container`);

    if (tier === 'flexi') {
      // Flexi = any distance above the tier minimum — no fixed list, use free entry
      if (distSelect) {
        distSelect.style.display = 'none';
        distSelect.disabled = true;
      }
      if (customContainer) customContainer.style.display = 'block';
      const customInput = document.getElementById(`custom-dist-${cat}`);
      if (customInput) customInput.value = FLEXI_MIN_KM[cat];
      state.cart.activity_distance = FLEXI_MIN_KM[cat] + 'k';
    } else {
      if (customContainer) customContainer.style.display = 'none';
      if (distSelect) {
        distSelect.style.display = '';
        distSelect.disabled = false;
        const options = (TIER_DISTANCE_OPTIONS[cat] && TIER_DISTANCE_OPTIONS[cat][tier]) || [];
        distSelect.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        if (options.length > 0) {
          distSelect.value = options[0].value;
          state.cart.activity_distance = options[0].value;
        }
      }
    }

    this.validateCartSelection();
  },

  onCustomDistanceChange(cat) {
    this.validateCartSelection();
  },

  // Resolves the active distance selection (including Flexi free-entry inputs),
  // validates minimums, and enables/disables the submit button. No network
  // call needed here — the selection is only persisted on final submit.
  validateCartSelection() {
    const cat = state.cart.activity_type;
    const tier = state.cart.activity_tier;

    if (cat === 'mix') {
      state.cart.activity_distance = null;
    } else if (tier === 'flexi') {
      const customInput = document.getElementById(`custom-dist-${cat}`);
      state.cart.activity_distance = (customInput ? customInput.value : FLEXI_MIN_KM[cat]) + 'k';
    } else {
      const distSelect = document.getElementById(`select-dist-${cat}`);
      state.cart.activity_distance = distSelect ? distSelect.value : '';
    }

    // Client-side validation for Flexi minimums
    let hasValidationError = false;

    if (cat === 'run' && tier === 'flexi') {
      const val = parseFloat(document.getElementById('custom-dist-run').value) || 0;
      const errorSpan = document.getElementById('custom-dist-run-error');
      if (val < FLEXI_MIN_KM.run) {
        if (errorSpan) {
          errorSpan.style.display = 'block';
          errorSpan.textContent = `Minimum Flexi distance is ${FLEXI_MIN_KM.run} km`;
        }
        hasValidationError = true;
      } else if (errorSpan) {
        errorSpan.style.display = 'none';
      }
    }

    if (cat === 'cycle' && tier === 'flexi') {
      const val = parseFloat(document.getElementById('custom-dist-cycle').value) || 0;
      const errorSpan = document.getElementById('custom-dist-cycle-error');
      if (val < FLEXI_MIN_KM.cycle) {
        if (errorSpan) {
          errorSpan.style.display = 'block';
          errorSpan.textContent = `Minimum Flexi distance is ${FLEXI_MIN_KM.cycle} km`;
        }
        hasValidationError = true;
      } else if (errorSpan) {
        errorSpan.style.display = 'none';
      }
    }

    // Run/Cycle require a tier to be chosen before submitting
    if ((cat === 'run' || cat === 'cycle') && !tier) {
      hasValidationError = true;
    }

    // Disable/Enable Cart Submit Button
    const submitBtn = document.querySelector('#cart-form button[type="submit"]');
    if (submitBtn) {
      if (hasValidationError) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.style.cursor = 'not-allowed';
      } else {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
      }
    }
  },

  // ---------------------------------------------------------
  // STRAVA OAUTH TRIGGER
  // ---------------------------------------------------------

  async connectStrava() {
    if (!state.currentUser) return;

    // The consent checkbox only exists on the mandatory Connect Strava view
    // (first-time connection). Reconnecting from the dashboard after already
    // having consented doesn't need to ask again.
    const consentCheckbox = document.getElementById('leaderboard-consent-checkbox');
    if (consentCheckbox && !consentCheckbox.checked) {
      alert('Please check the consent box before connecting your Strava account.');
      return;
    }

    try {
      if (consentCheckbox && consentCheckbox.checked) {
        await fetch('/api/user/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: state.currentUser.id, consent: true })
        });
      }

      const res = await fetch(`/api/auth/strava?userId=${state.currentUser.id}`);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert('Could not generate Strava login URL.');
      }
    } catch (err) {
      console.error(err);
      alert('Error initiating Strava authorize redirect.');
    }
  },

  // Lets athletes who connected Strava before the consent requirement existed
  // opt in retroactively so they appear on the Global Leaderboard.
  async grantLeaderboardConsent() {
    if (!state.currentUser) return;
    try {
      const res = await fetch('/api/user/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.currentUser.id, consent: true })
      });
      if (res.ok) {
        state.currentUser.leaderboard_consent = true;
        document.getElementById('legacy-consent-card').style.display = 'none';
      } else {
        alert('Could not save your consent. Please try again.');
      }
    } catch (err) {
      console.error(err);
      alert('Connection error saving consent.');
    }
  },

  openDeleteAccountOverlay() {
    document.getElementById('delete-account-email-input').value = '';
    document.getElementById('delete-account-error').style.display = 'none';
    document.getElementById('delete-account-overlay').style.display = 'flex';
  },

  closeDeleteAccountOverlay() {
    document.getElementById('delete-account-overlay').style.display = 'none';
  },

  async confirmDeleteAccount() {
    if (!state.currentUser) return;
    const email = document.getElementById('delete-account-email-input').value.trim();
    const errorEl = document.getElementById('delete-account-error');
    errorEl.style.display = 'none';

    if (email.toLowerCase() !== state.currentUser.email.toLowerCase()) {
      errorEl.textContent = 'Email does not match your account. Please try again.';
      errorEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/user/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.currentUser.id, email })
      });
      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Could not delete account.';
        errorEl.style.display = 'block';
        return;
      }

      alert('Your account and all associated data have been permanently deleted.');
      state.currentUser = null;
      localStorage.removeItem('athlete_email');
      this.closeDeleteAccountOverlay();
      this.switchView('gate');
    } catch (err) {
      console.error(err);
      errorEl.textContent = 'Connection error deleting account.';
      errorEl.style.display = 'block';
    }
  },

  // ---------------------------------------------------------
  // ATHLETE PORTAL DASHBOARD CONTROLLERS
  // ---------------------------------------------------------

  async loadDashboard() {
    const user = state.currentUser;
    if (!user) return;

    try {
      const res = await fetch(`/api/user/dashboard?email=${encodeURIComponent(user.email)}`);
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Failed to sync dashboard details.');
        return;
      }

      // Update state user record
      state.currentUser = data.user;
      
      // Sidebar Profile Values
      document.getElementById('dash-avatar').textContent = user.name[0].toUpperCase() + user.surname[0].toUpperCase();
      document.getElementById('dash-name').textContent = `${data.user.name} ${data.user.surname}`;
      document.getElementById('dash-email').textContent = data.user.email;
      const tierLabel = data.user.activity_tier
        ? ` — ${data.user.activity_tier.charAt(0).toUpperCase() + data.user.activity_tier.slice(1)}`
        : '';
      const distanceLabel = data.user.activity_distance ? ` (${data.user.activity_distance})` : '';
      document.getElementById('dash-event').textContent = `${data.user.activity_type}${tierLabel}${distanceLabel}`;

      // Connection Status Badge
      const statusBadge = document.getElementById('strava-status-badge');
      const dashStravaBtn = document.getElementById('dash-strava-btn');
      
      if (data.user.strava_access_token) {
        statusBadge.className = 'strava-badge connected';
        statusBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Connected (${data.user.strava_id})`;
        dashStravaBtn.innerHTML = `<i class="fa-brands fa-strava"></i> Reconnect with Strava`;
      } else {
        statusBadge.className = 'strava-badge disconnected';
        statusBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Not Linked`;
        dashStravaBtn.innerHTML = `<i class="fa-brands fa-strava"></i> Connect with Strava`;
      }

      // Athletes who connected Strava before the leaderboard consent
      // requirement existed won't have leaderboard_consent set -- prompt
      // them to opt in retroactively so they can appear on the leaderboard.
      const legacyConsentCard = document.getElementById('legacy-consent-card');
      if (legacyConsentCard) {
        legacyConsentCard.style.display = (data.user.strava_access_token && !data.user.leaderboard_consent) ? 'block' : 'none';
      }

      // Metric Summary Boxes
      document.getElementById('stat-streak').textContent = `${data.streak} Days`;
      document.getElementById('stat-distance').textContent = data.user.activity_distance ? `${data.targetDistance} km` : 'No Target';
      document.getElementById('stat-activities').textContent = data.activities.length;

      // Populate Sync Log Table
      const tableBody = document.getElementById('activities-table-body');
      const cardList = document.getElementById('activities-card-list');
      tableBody.innerHTML = '';
      cardList.innerHTML = '';

      if (data.activities.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
              No activities found. Use the dev panel to add mock records or click sync if connected.
            </td>
          </tr>
        `;
        cardList.innerHTML = `
          <div style="text-align: center; color: var(--text-secondary); padding: 2rem 1rem;">
            No activities found. Use the dev panel to add mock records or click sync if connected.
          </div>
        `;
      } else {
        data.activities.forEach(act => {
          const row = document.createElement('tr');
          const typeDisplay = getActivityDisplay(act.type);
          row.innerHTML = `
            <td><strong>${act.activity_date}</strong></td>
            <td>
              <i class="fa-solid ${typeDisplay.icon}"></i> ${typeDisplay.label}
              ${act.is_manual ? '<span class="check-badge invalid" title="Manually entered on Strava (no device/GPS data) — counts as a break on the leaderboard" style="margin-left: 0.4rem;"><i class="fa-solid fa-pen"></i> Manual</span>' : ''}
            </td>
            <td>${parseFloat(act.distance).toFixed(2)} km</td>
            <td>${formatTime(act.elapsed_time)}</td>
            <td>
              ${act.is_valid_distance
                ? '<span class="check-badge valid"><i class="fa-solid fa-circle-check"></i> Passed</span>'
                : `<span class="check-badge invalid" title="Expected ${data.targetDistance} km"><i class="fa-solid fa-circle-xmark"></i> Short</span>`}
            </td>
            <td>
              ${act.is_consistent
                ? '<span class="check-badge valid"><i class="fa-solid fa-calendar-check"></i> Streak OK</span>'
                : `<span class="check-badge invalid" title="Daily streak broken starting ${state.eventStartDate}"><i class="fa-solid fa-calendar-times"></i> Broken</span>`}
            </td>
            <td><strong>${formatSpeed(act.speed)}</strong></td>
          `;
          tableBody.appendChild(row);

          const card = document.createElement('div');
          card.className = 'activity-card';
          card.innerHTML = `
            <div class="activity-card-header">
              <span class="activity-card-title">
                <i class="fa-solid ${typeDisplay.icon}"></i> ${typeDisplay.label}
                &middot; ${act.activity_date}
                ${act.is_manual ? '<span class="check-badge invalid" title="Manually entered on Strava — counts as a break on the leaderboard"><i class="fa-solid fa-pen"></i> Manual</span>' : ''}
              </span>
            </div>
            <div class="activity-card-grid">
              <span>Distance</span><span>${parseFloat(act.distance).toFixed(2)} km</span>
              <span>Elapsed time</span><span>${formatTime(act.elapsed_time)}</span>
              <span>Speed</span><span><strong>${formatSpeed(act.speed)}</strong></span>
            </div>
            <div class="activity-card-badges">
              ${act.is_valid_distance
                ? '<span class="check-badge valid"><i class="fa-solid fa-circle-check"></i> Target met</span>'
                : `<span class="check-badge invalid" title="Expected ${data.targetDistance} km"><i class="fa-solid fa-circle-xmark"></i> Short</span>`}
              ${act.is_consistent
                ? '<span class="check-badge valid"><i class="fa-solid fa-calendar-check"></i> Streak OK</span>'
                : `<span class="check-badge invalid" title="Daily streak broken starting ${state.eventStartDate}"><i class="fa-solid fa-calendar-times"></i> Broken</span>`}
            </div>
          `;
          cardList.appendChild(card);
        });
      }

      // Switch active tab view and load leaderboard if it's the default
      this.switchTab(state.activeTab);
      if (state.activeTab === 'leaderboard') this.loadLeaderboard();

    } catch (err) {
      console.error(err);
    }
  },

  async syncActivities() {
    if (!state.currentUser) return;
    try {
      const res = await fetch(`/api/admin/sync-all`, { method: 'POST' });
      if (res.ok) {
        this.loadDashboard();
      } else {
        alert('Sync failed. Check Strava linking status.');
      }
    } catch (e) {
      console.error(e);
    }
  },

  switchTab(tabId) {
    state.activeTab = tabId;
    
    // Toggle active state on buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    // Find active tab button by onclick pattern or matching text
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
      if (btn.getAttribute('onclick').includes(tabId)) {
        btn.classList.add('active');
      }
    });

    // Toggle active state on panes
    document.querySelectorAll('.tab-content').forEach(pane => {
      pane.classList.remove('active');
    });
    document.getElementById(`tab-${tabId}`).classList.add('active');
  },

  // Switches the active event sub-tab (Running/Walking, Cycling, Mixed) under
  // the Global Leaderboard tab and reloads rankings scoped to that category.
  switchLeaderboardCategory(category) {
    state.leaderboardCategory = category;
    document.querySelectorAll('.subtab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`subtab-${category}`).classList.add('active');

    // Only Run/Cycle have a distance filter; show the matching one and reset
    // both so a stale filter from the previous tab doesn't carry over.
    const runWrap = document.getElementById('leaderboard-distance-run-wrap');
    const cycleWrap = document.getElementById('leaderboard-distance-cycle-wrap');
    document.getElementById('leaderboard-distance-run').value = '';
    document.getElementById('leaderboard-distance-cycle').value = '';
    if (runWrap) runWrap.style.display = category === 'run' ? '' : 'none';
    if (cycleWrap) cycleWrap.style.display = category === 'cycle' ? '' : 'none';

    this.loadLeaderboard();
  },

  async loadLeaderboard() {
    const category = state.leaderboardCategory;
    const distanceSelect = document.getElementById(`leaderboard-distance-${category}`);
    const distance = distanceSelect ? distanceSelect.value : '';

    let url = '/api/leaderboard?';
    if (category) url += `category=${category}&`;
    if (distance) url += `distance=${distance}&`;

    try {
      const res = await fetch(url);
      const data = await res.json();
      
      const tbody = document.getElementById('leaderboard-table-body');
      const cardList = document.getElementById('leaderboard-card-list');
      tbody.innerHTML = '';
      cardList.innerHTML = '';

      if (data.length === 0) {
        const emptyMsg = 'No athletes registered for this event yet.';
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
              ${emptyMsg}
            </td>
          </tr>
        `;
        cardList.innerHTML = `
          <div style="text-align: center; color: var(--text-secondary); padding: 2rem 1rem;">
            ${emptyMsg}
          </div>
        `;
        return;
      }

      data.forEach(item => {
        const tr = document.createElement('tr');

        let rankClass = '';
        if (item.rank === 1) rankClass = 'rank-1';
        else if (item.rank === 2) rankClass = 'rank-2';
        else if (item.rank === 3) rankClass = 'rank-3';

        const status = this.formatLeaderboardStatus(item);

        const paceLabel = this.formatPace(item.avgPaceSecPerKm);

        tr.innerHTML = `
          <td class="rank-column ${rankClass}">#${item.rank}</td>
          <td><strong>${item.name}</strong></td>
          <td style="text-transform: capitalize;">${item.category} (${item.targetDistance})</td>
          <td style="color: ${status.color}; font-weight: 700;">${status.label}</td>
          <td>${item.totalDistance.toFixed(2)} km</td>
          <td>${paceLabel}</td>
        `;
        tbody.appendChild(tr);

        const card = document.createElement('div');
        card.className = 'leaderboard-card';
        card.innerHTML = `
          <div class="leaderboard-card-rank ${rankClass}">#${item.rank}</div>
          <div class="leaderboard-card-body">
            <div class="leaderboard-card-name">${item.name}</div>
            <div class="leaderboard-card-meta">${item.category} (${item.targetDistance})</div>
          </div>
          <div class="leaderboard-card-stats">
            <div class="leaderboard-card-stat-row">
              <span class="leaderboard-card-stat-label">Total Distance</span>
              <span class="leaderboard-card-distance">${item.totalDistance.toFixed(2)} km</span>
            </div>
            <div class="leaderboard-card-stat-row">
              <span class="leaderboard-card-stat-label">Pace</span>
              <span class="leaderboard-card-distance">${paceLabel}</span>
            </div>
            <div class="leaderboard-card-speed" style="color: ${status.color};">${status.label}</div>
          </div>
        `;
        cardList.appendChild(card);
      });

    } catch (e) {
      console.error('Error fetching rankings:', e);
    }
  },

  // Maps the breaks/isPerfect fields from /api/leaderboard into a display label + color
  formatLeaderboardStatus(item) {
    if (item.isPerfect) {
      return { label: 'Perfect', color: 'var(--success, #22c55e)' };
    }
    if (item.breaks === 0) {
      return { label: 'Consistent (Short)', color: 'var(--secondary)' };
    }
    return { label: `${item.breaks} Break${item.breaks === 1 ? '' : 's'}`, color: 'var(--danger, #ef4444)' };
  },

  // Formats seconds-per-km as "M:SS /km"; athletes with zero logged distance
  // get avgPaceSecPerKm = Infinity from the API, shown as a dash.
  formatPace(secPerKm) {
    if (!isFinite(secPerKm)) return '—';
    const mins = Math.floor(secPerKm / 60);
    const secs = Math.round(secPerKm % 60);
    return `${mins}:${String(secs).padStart(2, '0')} /km`;
  },

  // ---------------------------------------------------------
  // ADMIN ACTIVITY VIEWER
  // ---------------------------------------------------------

  adminLogout() {
    state.adminSecret = null;
    state.adminExpandedUserId = null;
    state.adminActivitiesCache = {};
    sessionStorage.removeItem('admin_secret');
    this.switchView('gate');
  },

  async loadAdminUsers() {
    if (!state.adminSecret) {
      this.switchView('admin-login');
      return;
    }

    const tbody = document.getElementById('admin-users-table-body');
    try {
      const res = await fetch('/api/admin/dashboard-users', {
        headers: { 'x-admin-secret': state.adminSecret }
      });

      if (res.status === 401) {
        // Stored secret no longer valid — force re-login rather than show a broken page
        this.adminLogout();
        alert('Admin session expired or invalid. Please log in again.');
        return;
      }

      const users = await res.json();
      state.adminUsers = users;
      this.renderAdminUsersTable(users);
    } catch (err) {
      console.error(err);
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Failed to load athletes.</td></tr>`;
    }
  },

  renderAdminUsersTable(users) {
    const tbody = document.getElementById('admin-users-table-body');
    tbody.innerHTML = '';

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No athletes registered yet.</td></tr>`;
      return;
    }

    users.forEach(u => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.innerHTML = `
        <td><i class="fa-solid fa-chevron-right admin-expand-icon" id="admin-chevron-${u.id}"></i></td>
        <td><strong>${u.name}</strong><br><span style="font-size: 0.75rem; color: var(--text-secondary);">${u.email}</span></td>
        <td style="text-transform: capitalize;">${u.category}${u.tier ? ` — ${u.tier}` : ''}${u.distance ? ` (${u.distance})` : ''}</td>
        <td>${u.stravaConnected
          ? '<span class="check-badge valid"><i class="fa-solid fa-circle-check"></i> Connected</span>'
          : '<span class="check-badge invalid"><i class="fa-solid fa-circle-xmark"></i> Not Linked</span>'}</td>
        <td>${u.activityCount}</td>
        <td>${u.lastSyncedAt ? new Date(u.lastSyncedAt).toLocaleString() : 'Never'}</td>
      `;
      row.addEventListener('click', () => this.toggleAdminUserExpand(u.id));
      tbody.appendChild(row);

      const expandRow = document.createElement('tr');
      expandRow.id = `admin-expand-row-${u.id}`;
      expandRow.style.display = 'none';
      expandRow.innerHTML = `
        <td colspan="6" style="padding: 0;">
          <div id="admin-expand-content-${u.id}" style="padding: 1rem 1.5rem; background: rgba(255,255,255,0.02);">
            <div style="text-align: center; color: var(--text-secondary); padding: 1rem;">Loading activities...</div>
          </div>
        </td>
      `;
      tbody.appendChild(expandRow);
    });
  },

  async toggleAdminUserExpand(userId) {
    const expandRow = document.getElementById(`admin-expand-row-${userId}`);
    const chevron = document.getElementById(`admin-chevron-${userId}`);
    const isOpen = expandRow.style.display !== 'none';

    if (isOpen) {
      expandRow.style.display = 'none';
      chevron.classList.remove('fa-chevron-down');
      chevron.classList.add('fa-chevron-right');
      return;
    }

    expandRow.style.display = 'table-row';
    chevron.classList.remove('fa-chevron-right');
    chevron.classList.add('fa-chevron-down');

    if (state.adminActivitiesCache[userId]) {
      this.renderAdminUserActivities(userId, state.adminActivitiesCache[userId]);
      return;
    }

    try {
      const res = await fetch(`/api/admin/user-activities/${userId}`, {
        headers: { 'x-admin-secret': state.adminSecret }
      });
      const activities = await res.json();
      state.adminActivitiesCache[userId] = activities;
      this.renderAdminUserActivities(userId, activities);
    } catch (err) {
      console.error(err);
      document.getElementById(`admin-expand-content-${userId}`).innerHTML =
        '<div style="text-align: center; color: var(--danger); padding: 1rem;">Failed to load activities.</div>';
    }
  },

  renderAdminUserActivities(userId, activities) {
    const container = document.getElementById(`admin-expand-content-${userId}`);

    if (activities.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 1rem;">No activities logged.</div>';
      return;
    }

    const rows = activities.map(act => {
      const typeDisplay = getActivityDisplay(act.type);
      return `
        <tr>
          <td>${act.activity_date}</td>
          <td><i class="fa-solid ${typeDisplay.icon}"></i> ${typeDisplay.label}${act.is_manual ? ' <span class="check-badge invalid" style="margin-left: 0.3rem;"><i class="fa-solid fa-pen"></i> Manual</span>' : ''}</td>
          <td>${parseFloat(act.distance).toFixed(2)} km</td>
          <td>${formatTime(act.elapsed_time)}</td>
          <td>${act.is_valid_distance ? '<span class="check-badge valid">Passed</span>' : '<span class="check-badge invalid">Short</span>'}</td>
          <td>${act.is_consistent ? '<span class="check-badge valid">Streak OK</span>' : '<span class="check-badge invalid">Broken</span>'}</td>
          <td>${act.has_gps ? 'Yes' : 'No'}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table style="width: 100%; font-size: 0.85rem;">
        <thead>
          <tr>
            <th style="text-align: left; padding-bottom: 0.5rem;">Date</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">Activity</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">Distance</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">Elapsed Time</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">Check 1</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">Check 2</th>
            <th style="text-align: left; padding-bottom: 0.5rem;">GPS</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  // ---------------------------------------------------------
  // DEVELOPER SIMULATOR DRAWER CONTROLLERS
  // ---------------------------------------------------------

  toggleDevDrawer() {
    state.devDrawerOpen = !state.devDrawerOpen;
    const drawer = document.getElementById('dev-drawer');
    if (state.devDrawerOpen) {
      drawer.classList.add('open');
      this.loadDevData();
    } else {
      drawer.classList.remove('open');
    }
  },

  switchDevTab(tabId) {
    state.activeDevTab = tabId;
    
    // Toggle active buttons
    document.querySelectorAll('.dev-tab').forEach(btn => {
      btn.classList.remove('active');
      if (btn.getAttribute('onclick').includes(tabId)) {
        btn.classList.add('active');
      }
    });

    // Toggle panes
    document.querySelectorAll('.dev-section-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    document.getElementById(`pane-${tabId}`).classList.add('active');
  },

  async loadDevData() {
    try {
      // 1. Fetch Users
      const userRes = await fetch('/api/admin/users');
      const users = await userRes.json();
      
      const usersList = document.getElementById('dev-users-list');
      const mockActUserSelect = document.getElementById('mock-act-user');
      
      usersList.innerHTML = '';
      
      // Save current selection
      const currentSelectedUser = mockActUserSelect.value;
      mockActUserSelect.innerHTML = '<option value="">-- Choose User --</option>';

      if (users.length === 0) {
        usersList.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-secondary);">No athletes registered yet.</p>';
      } else {
        users.forEach(u => {
          // List user card
          const card = document.createElement('div');
          card.style.background = 'rgba(0, 0, 0, 0.15)';
          card.style.border = '1px solid var(--border-card)';
          card.style.borderRadius = '6px';
          card.style.padding = '0.5rem';
          card.style.display = 'flex';
          card.style.justifyContent = 'space-between';
          card.style.alignItems = 'center';
          card.style.fontSize = '0.8rem';

          card.innerHTML = `
            <div>
              <strong style="color: var(--primary);">${u.name} ${u.surname}</strong>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">${u.email}</div>
              <div style="font-size: 0.7rem; margin-top: 0.15rem;">
                Registered: ${u.is_paid ? '✅' : '❌'} | Strava: ${u.strava_access_token ? '✅' : '❌'}
              </div>
            </div>
            <button class="btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 0.7rem;" onclick="app.loginAs('${u.email}')">Log In</button>
          `;
          usersList.appendChild(card);

          // Populate select
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = `${u.name} (${u.email})`;
          mockActUserSelect.appendChild(opt);
        });

        // Restore selection
        mockActUserSelect.value = currentSelectedUser;
      }

      // Emails fetch removed

    } catch (e) {
      console.error('Dev data fetch failed:', e);
    }
  },

  loginAs(email) {
    this.autoLoginByEmail(email, 'dashboard');
    this.toggleDevDrawer();
  },

  async submitMockActivity(event) {
    event.preventDefault();
    const userId = document.getElementById('mock-act-user').value;
    const date = document.getElementById('mock-act-date').value;
    const type = document.getElementById('mock-act-type').value;
    const dist = parseFloat(document.getElementById('mock-act-dist').value);
    
    // Parse time
    const hr = parseInt(document.getElementById('mock-act-hr').value) || 0;
    const min = parseInt(document.getElementById('mock-act-min').value) || 0;
    const sec = parseInt(document.getElementById('mock-act-sec').value) || 0;
    const elapsedSecs = (hr * 3600) + (min * 60) + sec;

    const hasGps = document.getElementById('mock-act-gps').checked;
    const coords = document.getElementById('mock-act-coords').value;
    const isManual = document.getElementById('mock-act-manual').checked;

    if (!userId) {
      alert('Please select an athlete.');
      return;
    }

    try {
      const res = await fetch('/api/admin/mock-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          activity_date: date,
          type,
          distance: dist,
          elapsed_time: elapsedSecs,
          has_gps: hasGps,
          start_latlng: coords,
          is_manual: isManual
        })
      });

      const data = await res.json();
      if (res.ok) {
        alert('Mock activity recorded successfully!');
        // Refresh dashboard if current user
        if (state.currentUser && state.currentUser.id === userId) {
          this.loadDashboard();
        }
        this.loadDevData();
      } else {
        alert('Failed: ' + data.error);
      }
    } catch (e) {
      alert('Network error.');
    }
  },

  async triggerGlobalSync() {
    try {
      const res = await fetch('/api/admin/sync-all', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert('Sync complete!');
        if (state.activeView === 'dashboard') {
          this.loadDashboard();
        }
      }
    } catch (e) {
      console.error(e);
    }
  },

  async resetDatabase() {
    if (!confirm('Are you sure you want to completely wipe the database? All users and activity entries will be permanently deleted.')) {
      return;
    }
    try {
      const res = await fetch('/api/admin/reset', { method: 'POST' });
      if (res.ok) {
        alert('Database cleared successfully.');
        localStorage.removeItem('athlete_email');
        state.currentUser = null;
        this.switchView('gate');
      }
    } catch (e) {
      console.error(e);
    }
  },

};

// Initialize App on DOM Content Loaded
document.addEventListener('DOMContentLoaded', () => app.init());
window.app = app;
