// The window's end-user capabilities, one stable id each (after Spec Surgeon's frontend/src/lib/capabilities.ts).
// A control in the page declares the capability it gives the user with data-capability; the guided tour's
// steps (public/tour.js) name the same ids. tests/tour.test.mjs holds the two sets equal in both directions,
// so a control cannot ship untaught and a step cannot describe a control the page does not have.
export const CAPABILITIES=[
  // the tour itself
  'tour.start','tour.controls','tour.finish',
  // the sidebar and the top bar
  'sidebar.projects','sidebar.new-research','sidebar.export-addresses','sidebar.export-workspace','sidebar.import-workspace','sidebar.connection','top.settings',
  // API & spending
  'settings.key','settings.remember','settings.spending','settings.forget','settings.updates','settings.diagnostics',
  // the footer and updates
  'footer.about','footer.trust','footer.guide','update.banner',
  // the new-project form
  'form.address','form.country','form.discipline','form.name','form.context','form.mode','form.start',
  // the project header
  'project.rename','project.chat','project.resume','project.stop','project.finish-partial','project.connect','project.reconcile','project.export','project.delete',
  // the report
  'report.tabs','report.evidence','questions.answer','questions.dismiss','questions.ask-atlas','questions.reopen','questions.research-answers','notes.remove','codes.research-standards','sources.add-document','activity.resolve-charge',
  // Chat with Atlas
  'chat.launcher','chat.panel','chat.starters','chat.composer','chat.depth','chat.attach-document','chat.attach-image','chat.stop','chat.retry','chat.earlier','chat.copy','chat.citations','chat.proposal','chat.limits',
];
