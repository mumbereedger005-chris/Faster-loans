'use strict';
// middleware/validate.js — express-validator result checker + input sanitiser
const { validationResult } = require('express-validator');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed.',
      errors:  errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

module.exports = { validate };
