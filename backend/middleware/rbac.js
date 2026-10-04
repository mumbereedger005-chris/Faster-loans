'use strict';
// middleware/rbac.js — Role-based access control
const HIERARCHY = { customer: 0, officer: 1, admin: 2, superadmin: 3 };

/**
 * requireRole('admin') — user role must be >= the specified role.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    const userLevel   = HIERARCHY[req.user.role] ?? -1;
    const minRequired = Math.min(...roles.map(r => HIERARCHY[r] ?? 99));
    if (userLevel < minRequired) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Requires role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

/**
 * requireOwnerOrAdmin — customer can only access their own resources.
 * Compares req.params.userId (or req.params.id) with req.user.id.
 */
function requireOwnerOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated.' });
  const paramId = parseInt(req.params.userId || req.params.id);
  const isOwner = req.user.id === paramId;
  const isAdmin = HIERARCHY[req.user.role] >= HIERARCHY['admin'];
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }
  next();
}

module.exports = { requireRole, requireOwnerOrAdmin };
