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
  activeDevTab: 'dev-users',
  devDrawerOpen: false,
  dashboardPollSeconds: 15,
  dashboardPollTimer: null
};

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
      const dob = document.getElementById('signup-dob').value;
      const gender = document.getElementById('signup-gender').value;
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
          body: JSON.stringify({ name, surname, dob, gender, email, mobile, password })
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
      // Mix has no tier — single flat distance select, unchanged behavior
      const mixSelect = document.getElementById('select-dist-mix');
      if (mixSelect) {
        mixSelect.disabled = false;
        if (mixSelect.value === "") {
          const firstValidOpt = Array.from(mixSelect.options).find(opt => opt.value !== "");
          if (firstValidOpt) mixSelect.value = firstValidOpt.value;
        }
      }
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
      const mixSelect = document.getElementById('select-dist-mix');
      state.cart.activity_distance = mixSelect ? mixSelect.value : '';
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
    try {
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
      document.getElementById('dash-age').textContent = this.calculateAge(data.user.dob) + ' years';
      document.getElementById('dash-gender').textContent = data.user.gender;
      const tierLabel = data.user.activity_tier
        ? ` — ${data.user.activity_tier.charAt(0).toUpperCase() + data.user.activity_tier.slice(1)}`
        : '';
      document.getElementById('dash-event').textContent = `${data.user.activity_type}${tierLabel} (${data.user.activity_distance})`;

      // Connection Status Badge
      const statusBadge = document.getElementById('strava-status-badge');
      const dashStravaBtn = document.getElementById('dash-strava-btn');
      
      if (data.user.strava_access_token) {
        statusBadge.className = 'strava-badge connected';
        statusBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Connected (${data.user.strava_id})`;
        dashStravaBtn.innerHTML = `<i class="fa-brands fa-strava"></i> Reconnect Strava`;
      } else {
        statusBadge.className = 'strava-badge disconnected';
        statusBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Not Linked`;
        dashStravaBtn.innerHTML = `<i class="fa-brands fa-strava"></i> Connect Strava`;
      }

      // Metric Summary Boxes
      document.getElementById('stat-streak').textContent = `${data.streak} Days`;
      document.getElementById('stat-distance').textContent = `${data.targetDistance} km`;
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
          row.innerHTML = `
            <td><strong>${act.activity_date}</strong></td>
            <td style="text-transform: capitalize;">
              ${act.type === 'run' ? '<i class="fa-solid fa-person-running"></i> Run' : '<i class="fa-solid fa-bicycle"></i> Cycle'}
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
                : '<span class="check-badge invalid" title="Daily streak broken starting 2026-07-26"><i class="fa-solid fa-calendar-times"></i> Broken</span>'}
            </td>
            <td><strong>${formatSpeed(act.speed)}</strong></td>
          `;
          tableBody.appendChild(row);

          const card = document.createElement('div');
          card.className = 'activity-card';
          card.innerHTML = `
            <div class="activity-card-header">
              <span class="activity-card-title" style="text-transform: capitalize;">
                ${act.type === 'run' ? '<i class="fa-solid fa-person-running"></i> Run' : '<i class="fa-solid fa-bicycle"></i> Cycle'}
                &middot; ${act.activity_date}
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
                : '<span class="check-badge invalid" title="Daily streak broken starting 2026-07-26"><i class="fa-solid fa-calendar-times"></i> Broken</span>'}
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

  async loadLeaderboard() {
    const category = document.getElementById('filter-category').value;
    const gender = document.getElementById('filter-gender').value;
    const ageGroup = document.getElementById('filter-age').value;

    let url = '/api/leaderboard?';
    if (category) url += `category=${category}&`;
    if (gender) url += `gender=${gender}&`;
    if (ageGroup) url += `ageGroup=${ageGroup}&`;

    try {
      const res = await fetch(url);
      const data = await res.json();
      
      const tbody = document.getElementById('leaderboard-table-body');
      const cardList = document.getElementById('leaderboard-card-list');
      tbody.innerHTML = '';
      cardList.innerHTML = '';

      if (data.length === 0) {
        const emptyMsg = 'No athletes qualify on current filters. Consistent activities since 2026-07-26 are required.';
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
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

        tr.innerHTML = `
          <td class="rank-column ${rankClass}">#${item.rank}</td>
          <td><strong>${item.name}</strong></td>
          <td style="text-transform: capitalize;">${item.category} (${item.targetDistance})</td>
          <td style="color: var(--primary); font-weight: 700;">${item.streak} day${item.streak === 1 ? '' : 's'}</td>
          <td>${item.totalDistance.toFixed(2)} km</td>
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
            <div class="leaderboard-card-distance">${item.totalDistance.toFixed(2)} km</div>
            <div class="leaderboard-card-speed">${item.streak} day${item.streak === 1 ? '' : 's'} streak</div>
          </div>
        `;
        cardList.appendChild(card);
      });

    } catch (e) {
      console.error('Error fetching rankings:', e);
    }
  },

  calculateAge(dobStr) {
    const birthDate = new Date(dobStr);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
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
          start_latlng: coords
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
