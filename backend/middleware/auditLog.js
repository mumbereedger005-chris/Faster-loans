'use strict';
// middleware/auditLog.js — Write immutable audit entries
const db     = require('../db/db');
const logger = require('../services/loggerService');

/**
 * Write an audit record.  Safe — never throws.
 * @param {object} opts
 *   actorId, actorRole, action, entity, entityId,
 *   oldValues, newValues, ipAddress, userAgent
 */
async function writeAudit(opts) {
  try {
    const {
      actorId = null, actorRole = null,
      action, entity = null, entityId = null,
      oldValues = null, newValues = null,
      ipAddress = null, userAgent = null,
    } = opts;
    await db.execute(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity, entity_id,
          old_values, new_values, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        actorId, actorRole, action, entity, entityId ? String(entityId) : null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress, userAgent,
      ]
    );
  } catch (err) {
    logger.error('Failed to write audit log', { error: err.message, opts });
  }
}

/**
 * Express middleware factory — auto-logs any mutating request.
 * Usage: router.post('/path', auditMiddleware('loan.applied'), handler)
 */
function auditMiddleware(action, entity = null) {
  return (req, res, next) => {
    // Capture response finish event
    const finish = () => {
      if (res.statusCode < 400) {
        writeAudit({
          actorId:   req.user?.id,
          actorRole: req.user?.role,
          action,
          entity,
          entityId:  res.locals.auditEntityId,
          oldValues: res.locals.auditOld,
          newValues: res.locals.auditNew,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
    };
    res.on('finish', finish);
    next();
  };
}

module.exports = { writeAudit, auditMiddleware };
