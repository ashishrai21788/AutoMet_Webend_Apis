const express = require('express');
const { Tenant, AdminUser } = require('../models/adminModels');
const { createRequireAdmin } = require('../lib/adminAuth');
const { createBusinessContext } = require('../lib/businessContext');
const ctrl = require('../controllers/adminController');
const biz = require('../controllers/businessController');

const requireAdmin = createRequireAdmin({
  loadAdmin: (adminId) => AdminUser.findOne({ adminId }),
  loadTenant: (tenantId) => Tenant.findOne({ tenantId })
});

const withBusiness = createBusinessContext({ loadTenant: (tenantId) => Tenant.findOne({ tenantId }) });

const router = express.Router();

router.post('/auth/login', ctrl.login);
router.get('/auth/me', requireAdmin(), ctrl.me);
router.post('/auth/change-password', requireAdmin(), ctrl.changePassword);

router.get('/tenants', requireAdmin(), ctrl.listTenants);
router.post('/tenants', requireAdmin('clients.manage'), ctrl.createTenant);
router.patch('/tenants/:id/status', requireAdmin('clients.manage'), ctrl.setTenantStatus);

router.get('/users', requireAdmin('team.manage'), ctrl.listUsers);
router.post('/users', requireAdmin('team.manage'), ctrl.createUser);
router.patch('/users/:id/active', requireAdmin('team.manage'), ctrl.setUserActive);

router.get('/dashboard', requireAdmin('dashboard.view'), ctrl.dashboard);
router.get('/audit', requireAdmin('audit.view'), ctrl.listAudit);

// Business configuration. The business is named by the X-App-Id header and checked against the signed-in account.
// Reads need dashboard.view; changes need settings.manage (regions, categories, settings) or pricing.manage.
const read = [requireAdmin('dashboard.view'), withBusiness];
const manage = [requireAdmin('settings.manage'), withBusiness];
const pricing = [requireAdmin('pricing.manage'), withBusiness];

router.get('/business', ...read, biz.getBusiness);
router.get('/business/overview', ...read, biz.overview);
router.put('/business/settings', ...manage, biz.updateSettings);
router.put('/business/market', ...manage, biz.setMarket);
router.post('/business/setup/complete', ...manage, biz.completeSetup);

router.get('/business/regions', ...read, biz.listRegions);
router.post('/business/regions', ...manage, biz.createRegions);
router.post('/business/regions/locate', ...read, biz.locate);
router.patch('/business/regions/:id', ...manage, biz.updateRegion);

router.get('/business/categories', ...read, biz.listCategories);
router.post('/business/categories', ...manage, biz.createCategory);
router.patch('/business/categories/:id', ...manage, biz.updateCategory);

router.get('/business/fare-rules', ...read, biz.listFareRules);
router.put('/business/fare-rules', ...pricing, biz.saveFareRule);
router.delete('/business/fare-rules/:id', ...pricing, biz.deleteFareRule);
router.post('/business/fare-preview', ...read, biz.previewFare);

router.get('/business/cancellation-policies', ...read, biz.listPolicies);
router.put('/business/cancellation-policies', ...pricing, biz.savePolicy);
router.delete('/business/cancellation-policies/:id', ...pricing, biz.deletePolicy);

module.exports = router;
