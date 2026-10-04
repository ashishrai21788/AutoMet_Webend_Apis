const express = require('express');
const { Tenant, AdminUser } = require('../models/adminModels');
const { createRequireAdmin } = require('../lib/adminAuth');
const { createBusinessContext } = require('../lib/businessContext');
const ctrl = require('../controllers/adminController');
const biz = require('../controllers/businessController');
const fleetDrivers = require('../controllers/fleet/drivers');
const fleetVehicles = require('../controllers/fleet/vehicles');
const fleetAssign = require('../controllers/fleet/assignments');
const fleetDocs = require('../controllers/fleet/documents');
const { can } = require('../lib/adminPermissions');

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

// ---- drivers, vehicles, documents and verification ----
// Every record is read and written through the signed-in business only (req.data / req.legacyData). Opening a
// document needs documents.view, deciding on one needs verification.review, and both are recorded in the audit log.
const viewDrivers = [requireAdmin('drivers.view'), withBusiness];
const manageDrivers = [requireAdmin('drivers.manage'), withBusiness];
const viewVehicles = [requireAdmin('vehicles.view'), withBusiness];
const manageVehicles = [requireAdmin('vehicles.manage'), withBusiness];
const openDocuments = [requireAdmin('documents.view'), withBusiness];
const reviewDocuments = [requireAdmin('verification.review'), withBusiness];
// assigning touches both a driver and a vehicle, so it needs both permissions
const needs = (permission) => (req, res, next) => (can(req.admin, permission) ? next() : res.status(403).json({ success: false, message: 'Your role does not include this action', data: null }));

router.get('/business/requirements', ...read, fleetDocs.getRequirements);
router.put('/business/requirements', ...manage, fleetDocs.updateRequirements);

router.get('/business/drivers', ...viewDrivers, fleetDrivers.list);
router.post('/business/drivers', ...manageDrivers, fleetDrivers.create);
router.get('/business/drivers/:id', ...viewDrivers, fleetDrivers.get);
router.patch('/business/drivers/:id', ...manageDrivers, fleetDrivers.update);
router.post('/business/drivers/:id/status', ...manageDrivers, fleetDrivers.setStatus);
router.get('/business/drivers/:id/history', ...viewDrivers, fleetDrivers.history);
router.get('/business/drivers/:id/documents', ...viewDrivers, fleetDocs.listDriverDocuments);
router.post('/business/drivers/:id/documents', ...manageDrivers, fleetDocs.parseUpload, fleetDocs.submitDriverDocument);
router.post('/business/drivers/:id/assign-vehicle', ...manageDrivers, needs('vehicles.manage'), fleetAssign.assignVehicleToDriver);
router.post('/business/drivers/:id/unassign-vehicle', ...manageDrivers, needs('vehicles.manage'), fleetAssign.unassignFromDriver);
router.get('/business/driver-documents/:docId/url', ...openDocuments, fleetDocs.driverDocumentLink);
router.post('/business/driver-documents/:docId/review', ...reviewDocuments, fleetDocs.reviewDriverDocument);

router.get('/business/vehicles', ...viewVehicles, fleetVehicles.list);
router.post('/business/vehicles', ...manageVehicles, fleetVehicles.create);
router.get('/business/vehicles/:id', ...viewVehicles, fleetVehicles.get);
router.patch('/business/vehicles/:id', ...manageVehicles, fleetVehicles.update);
router.post('/business/vehicles/:id/status', ...manageVehicles, fleetVehicles.setStatus);
router.get('/business/vehicles/:id/history', ...viewVehicles, fleetVehicles.history);
router.get('/business/vehicles/:id/documents', ...viewVehicles, fleetDocs.listVehicleDocuments);
router.post('/business/vehicles/:id/documents', ...manageVehicles, fleetDocs.parseUpload, fleetDocs.submitVehicleDocument);
router.post('/business/vehicles/:id/assign-driver', ...manageVehicles, needs('drivers.manage'), fleetAssign.assignDriverToVehicle);
router.post('/business/vehicles/:id/unassign-driver', ...manageVehicles, needs('drivers.manage'), fleetAssign.unassignFromVehicle);
router.get('/business/vehicle-documents/:docId/url', ...openDocuments, fleetDocs.vehicleDocumentLink);
router.post('/business/vehicle-documents/:docId/review', ...reviewDocuments, fleetDocs.reviewVehicleDocument);

module.exports = router;
