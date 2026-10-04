/* ============================================
   FASTER LOANS UGANDA - MAIN JAVASCRIPT
   ============================================ */

/* ---- Navbar scroll effect ---- */
window.addEventListener('scroll', () => {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  if (window.scrollY > 50) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
});

/* ---- Mobile hamburger menu ---- */
function toggleMenu() {
  const links = document.getElementById('navLinks');
  const hamburger = document.getElementById('hamburger');
  if (!links) return;
  links.classList.toggle('open');
  const spans = hamburger.querySelectorAll('span');
  if (links.classList.contains('open')) {
    spans[0].style.transform = 'rotate(45deg) translate(5px, 6px)';
    spans[1].style.opacity   = '0';
    spans[2].style.transform = 'rotate(-45deg) translate(5px, -6px)';
  } else {
    spans[0].style.transform = '';
    spans[1].style.opacity   = '';
    spans[2].style.transform = '';
  }
}

/* ---- Close nav on outside click ---- */
document.addEventListener('click', (e) => {
  const links     = document.getElementById('navLinks');
  const hamburger = document.getElementById('hamburger');
  if (!links || !hamburger) return;
  if (!links.contains(e.target) && !hamburger.contains(e.target)) {
    links.classList.remove('open');
    hamburger.querySelectorAll('span').forEach(s => {
      s.style.transform = '';
      s.style.opacity   = '';
    });
  }
});

/* ---- Smooth scroll for anchor links ---- */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const href = link.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        const offset = 80;
        const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });
});

/* ---- Active nav link highlight based on scroll position ---- */
window.addEventListener('scroll', () => {
  const sections = document.querySelectorAll('section[id], div[id]');
  const navLinks = document.querySelectorAll('.nav-links a');
  let current = '';
  sections.forEach(section => {
    if (window.scrollY >= section.offsetTop - 100) {
      current = section.getAttribute('id');
    }
  });
  navLinks.forEach(link => {
    link.classList.remove('active');
    const href = link.getAttribute('href');
    if (href && href.includes('#' + current) && current) {
      link.classList.add('active');
    }
  });
});

/* ---- Counter animation for hero stats ---- */
function animateCounter(el, target, duration = 1500) {
  let start = 0;
  const increment = target / (duration / 16);
  const timer = setInterval(() => {
    start += increment;
    if (start >= target) {
      start = target;
      clearInterval(timer);
    }
    if (target >= 1000) {
      el.textContent = Math.floor(start).toLocaleString() + (el.dataset.suffix || '');
    } else {
      el.textContent = Math.floor(start) + (el.dataset.suffix || '');
    }
  }, 16);
}

/* ---- Intersection Observer for animations ---- */
const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity    = '1';
      entry.target.style.transform  = 'translateY(0)';
      entry.target.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    }
  });
}, observerOptions);

document.addEventListener('DOMContentLoaded', () => {
  /* Animate cards on scroll */
  document.querySelectorAll('.loan-card, .step-card, .feature-card, .testimonial-card, .stat-card').forEach((el, i) => {
    el.style.opacity   = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transitionDelay = `${i * 0.07}s`;
    observer.observe(el);
  });

  /* ---- Current year for footer ---- */
  const yearEls = document.querySelectorAll('.current-year');
  yearEls.forEach(el => { el.textContent = new Date().getFullYear(); });

  /* ---- Set minimum date for date inputs ---- */
  const today = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[type="date"]').forEach(input => {
    if (input.id === 'visitDate' || input.id === 'payDate') {
      input.min = today;
    }
  });
});

/* ---- Notification toast utility ---- */
function showToast(message, type = 'success', duration = 3500) {
  let toast = document.getElementById('fl-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fl-toast';
    toast.style.cssText = `
      position: fixed; bottom: 30px; right: 30px; z-index: 9999;
      padding: 14px 22px; border-radius: 10px; font-size: 0.9rem;
      font-weight: 600; color: #fff; max-width: 340px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.2);
      transform: translateX(120%); transition: transform 0.4s cubic-bezier(.4,0,.2,1);
      font-family: 'Segoe UI', sans-serif;
      display: flex; align-items: center; gap: 10px;
    `;
    document.body.appendChild(toast);
  }
  const colors = { success: '#1a5c2e', error: '#e74c3c', warning: '#f39c12', info: '#2980b9' };
  const icons  = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
  toast.style.background = colors[type] || colors.success;
  toast.textContent = `${icons[type] || ''} ${message}`;
  toast.style.transform = 'translateX(0)';
  setTimeout(() => { toast.style.transform = 'translateX(120%)'; }, duration);
}

/* ---- Form field validation helper ---- */
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^(\+256|0)[0-9]{9}$/.test(phone.replace(/\s/g, ''));
}

/* ---- Format number as UGX ---- */
function formatUGX(amount) {
  return 'UGX ' + Number(amount).toLocaleString('en-UG');
}

/* ---- Loan range quick info ---- */
const loanInfo = {
  personal:  { min: 250000,   max: 5000000,  rate: 3.5, tenure: 12 },
  business:  { min: 1000000,  max: 30000000, rate: 3.0, tenure: 36 },
  emergency: { min: 250000,   max: 2000000,  rate: 4.0, tenure: 6  },
  education: { min: 500000,   max: 10000000, rate: 3.0, tenure: 24 },
  logbook:   { min: 1000000,  max: 20000000, rate: 3.5, tenure: 24 },
  mortgage:  { min: 5000000,  max: 30000000, rate: 2.0, tenure: 48 },
};

/* ---- Keyboard navigation accessibility ---- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const links = document.getElementById('navLinks');
    if (links) links.classList.remove('open');
  }
});

/* ---- Lazy load hero background image ---- */
document.addEventListener('DOMContentLoaded', () => {
  const heroBg = document.querySelector('.hero-bg');
  if (heroBg) {
    const img = new Image();
    img.onload = () => { heroBg.style.opacity = '1'; };
    img.src = 'https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1600&q=80';
    heroBg.style.opacity = '0';
    heroBg.style.transition = 'opacity 1s ease';
    setTimeout(() => { heroBg.style.opacity = '1'; }, 100);
  }
});

/* ---- Print/download statement stub ---- */
function downloadStatement() {
  window.print();
}

/* ---- Session storage for application data ---- */
function saveApplicationData(data) {
  try { sessionStorage.setItem('fl_application', JSON.stringify(data)); } catch(e) {}
}

function loadApplicationData() {
  try { return JSON.parse(sessionStorage.getItem('fl_application') || '{}'); } catch(e) { return {}; }
}

/* ---- Back to top button ---- */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.innerHTML = '↑';
  btn.setAttribute('aria-label', 'Back to top');
  btn.style.cssText = `
    position: fixed; bottom: 80px; right: 28px; z-index: 999;
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--primary); color: #fff;
    border: none; cursor: pointer; font-size: 1.1rem; font-weight: 700;
    box-shadow: 0 4px 14px rgba(0,0,0,0.2);
    opacity: 0; transition: opacity 0.3s, transform 0.3s;
    transform: scale(0.8);
  `;
  document.body.appendChild(btn);

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('scroll', () => {
    if (window.scrollY > 400) {
      btn.style.opacity   = '1';
      btn.style.transform = 'scale(1)';
    } else {
      btn.style.opacity   = '0';
      btn.style.transform = 'scale(0.8)';
    }
  });
});
