import crypto from 'node:crypto';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

// Additive collection only. Production auto-indexing is disabled; review
// docs/MIGRATIONS.md before provisioning its TTL index or enabling reset mail.
const resetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { autoIndex: false });
export const deletingAccountIds = new Set();
const PasswordReset = mongoose.models.PasswordReset || mongoose.model('PasswordReset', resetSchema);

export function installAccountRoutes(app, context) {
  const { User, Report, Project, SiteCrawlJob, requireAuth, asyncHandler,
    hashPassword, verifyPasswordHash, generateApiKey, activeSiteCrawlJobIds } = context;

  app.get('/plans', (req, res) => res.json({ success: true, billingEnabled: false, plans: [
    { id:'free', dailyUnits:5 }, { id:'pro', dailyUnits:100 }, { id:'agency', dailyUnits:500 }
  ], notice:'Billing is disabled. Plans are descriptive; entitlements are enforced by the server. No paid checkout is available.' }));
  app.post('/billing/checkout', requireAuth, (req,res) => res.status(503).json({ success:false, message:'Billing is disabled pending provider setup and approval. No payment has been taken.' }));

  const passwordValid = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value) <= 72;
  app.post('/auth/change-password', requireAuth, asyncHandler(async (req,res) => {
    const user = await User.findById(req.authUser._id);
    if (!passwordValid(req.body?.newPassword) || typeof req.body?.currentPassword !== 'string' || Buffer.byteLength(req.body.currentPassword) > 72) return res.status(400).json({ success:false, message:'New password requires at least 8 characters and at most 72 UTF-8 bytes.' });
    if (!user || !await verifyPasswordHash(req.body.currentPassword, user.passwordHash)) return res.status(401).json({ success:false, message:'Current password is incorrect.' });
    const updated = await User.updateOne({ _id:user._id, passwordHash:user.passwordHash }, { $set: { passwordHash:await hashPassword(req.body.newPassword), apiKey:generateApiKey() } });
    if (!updated.modifiedCount) return res.status(409).json({ success:false, message:'Account changed. Log in again.' });
    res.clearCookie('aegis_session', { path:'/' });
    res.json({ success:true, message:'Password changed; all sessions and API keys revoked. Log in again.' });
  }));

  app.post('/auth/rotate-api-key', requireAuth, asyncHandler(async (req,res) => {
    if (typeof req.body?.password !== 'string' || Buffer.byteLength(req.body.password) > 72) return res.status(400).json({success:false,message:'Password required.'});
    const user = await User.findById(req.authUser._id);
    if (!user || !await verifyPasswordHash(req.body.password, user.passwordHash)) return res.status(401).json({success:false,message:'Invalid password.'});
    await User.updateOne({_id:user._id,apiKey:user.apiKey},{$set:{apiKey:generateApiKey()}});
    res.clearCookie('aegis_session', { path:'/' });
    res.json({success:true,message:'API key rotated and existing sessions revoked. Log in again.'});
  }));

  app.post('/auth/forgot-password', asyncHandler(async (req,res) => {
    // Explicit opt-in: neither SMTP delivery nor a paid provider is activated by default.
    if (process.env.PASSWORD_RESET_ENABLED !== 'true' || !process.env.SMTP_HOST || !process.env.MAIL_FROM || !process.env.APP_ORIGIN) return res.status(503).json({success:false,message:'Password recovery is not configured. Contact the service owner.'});
    if (mongoose.connection.readyState !== 1) return res.status(503).json({success:false,message:'Account service temporarily unavailable.'});
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254) return res.status(400).json({success:false,message:'Valid email required.'});
    const user = await User.findOne({email});
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await PasswordReset.deleteMany({userId:user._id});
      await PasswordReset.create({userId:user._id,tokenHash,expiresAt:new Date(Date.now()+30*60000)});
      const link = new URL('/#reset-token='+token,process.env.APP_ORIGIN);
      // TLS-only SMTP transport, credentials supplied through hosting secrets.
      const transport = nodemailer.createTransport({host:process.env.SMTP_HOST,port:465,secure:true,
        auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD} : undefined,
        connectionTimeout:5000,socketTimeout:10000});
      // Do not expose recipient existence or provider error details to callers.
      transport.sendMail({from:process.env.MAIL_FROM,to:user.email,subject:'Reset your AI Visibility password',
        text:`Reset your password using this link within 30 minutes: ${link.href}\nIf you did not request this, ignore this message.`})
        .catch(() => context.logger.error('MAIL','password_reset_delivery_failed',{}))
        .finally(() => transport.close());
    }
    res.json({success:true,message:'If the address belongs to an account, password reset instructions will be sent.'});
  }));

  app.post('/auth/reset-password', asyncHandler(async (req,res) => {
    if (process.env.PASSWORD_RESET_ENABLED !== 'true') return res.status(503).json({success:false,message:'Password recovery is not configured.'});
    if (mongoose.connection.readyState !== 1) return res.status(503).json({success:false,message:'Account service temporarily unavailable.'});
    if (!/^[a-f0-9]{64}$/.test(req.body?.token || '') || !passwordValid(req.body?.newPassword)) return res.status(400).json({success:false,message:'Valid token and password required.'});
    const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const reset = await PasswordReset.findOneAndDelete({tokenHash,expiresAt:{$gt:new Date()}});
    if (!reset) return res.status(400).json({success:false,message:'Reset link is invalid or expired.'});
    const result = await User.updateOne({_id:reset.userId},{$set:{passwordHash:await hashPassword(req.body.newPassword),apiKey:generateApiKey()}});
    if (!result.matchedCount) return res.status(400).json({success:false,message:'Reset link is invalid or expired.'});
    res.clearCookie('aegis_session',{path:'/'});
    res.json({success:true,message:'Password reset. All previous sessions and API keys revoked.'});
  }));

  app.delete('/auth/account', requireAuth, asyncHandler(async (req,res) => {
    const user = await User.findById(req.authUser._id);
    if (req.body?.confirmation !== 'DELETE' || typeof req.body?.password !== 'string' || Buffer.byteLength(req.body.password)>72 || !user || !await verifyPasswordHash(req.body.password,user.passwordHash)) return res.status(400).json({success:false,message:'Password and DELETE confirmation required.'});
    // Running workers must finish before deleting the owning account's data.
    if (context.hasActiveAnalyses() || activeSiteCrawlJobIds.size || await SiteCrawlJob.exists({userId:user._id,status:{$in:['running','pending']}})) return res.status(409).json({success:false,message:'Wait for active crawls to finish before deleting your account.'});
    if (deletingAccountIds.has(String(user._id))) return res.status(409).json({success:false,message:"Account deletion already in progress."});
    deletingAccountIds.add(String(user._id));
    let session;
    try {
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        const removed = await User.deleteOne({_id:user._id,passwordHash:user.passwordHash,apiKey:user.apiKey},{session});
        if (!removed.deletedCount) throw new Error('Account changed during deletion');
        for (const Model of [Report,Project,SiteCrawlJob,PasswordReset]) await Model.deleteMany({userId:user._id},{session});
      });
      // Cached scan data must not remain addressable through the deleted account.
      for (const key of context.scanCache.keys()) if (key.startsWith(String(user._id)+':')) context.scanCache.delete(key);
      res.clearCookie('aegis_session',{path:'/'});
      res.json({success:true,message:'Account and associated data deleted.'});
    } finally { deletingAccountIds.delete(String(user._id)); if (session) await session.endSession(); }
  }));

  app.get('/admin/status', requireAuth, asyncHandler(async (req,res) => {
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    if (!admins.includes(req.authUser.email)) return res.status(403).json({success:false,message:'Administrator access required.'});
    res.json({success:true,billingEnabled:false,activeSiteCrawls:activeSiteCrawlJobIds.size,
      accounts:await User.countDocuments(),reports:await Report.countDocuments()});
  }));
}
