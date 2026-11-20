// Actions must identify observed content. No network, provider calls or invented copy.
const text = value => String(value || '').replace(/\s+/gu, ' ').trim().slice(0,600);
const quote = value => `“${text(value)}”`;
export function evidenceAction(finding, evidence) {
  const p = finding.params || {}, url = finding.evidence?.url || evidence?.url;
  const topic = evidence?.topic;
  switch (finding.code) {
    case 'missingTitle': return evidence?.titleDraft?.text ? `Add a <title> on ${url}. Draft from the first H1: ${quote(evidence.titleDraft.text)}. Review before publishing.` : null;
    case 'missingDescription': return evidence?.descriptionDraft?.text ? `Add a meta description on ${url}. Draft excerpt from the first content paragraph: ${quote(evidence.descriptionDraft.text)}. Check that the excerpt is complete and accurate.` : null;
    case 'missingH1': return topic ? `Add the main visible heading on ${url} using the observed page topic ${quote(topic)}; check it describes the page before using it as the H1.` : null;
    case 'multipleH1': return `Review these ${p.count} H1 headings on ${url}: ${quote(finding.evidence.observed)}. Keep the main page heading and use section levels for subordinate headings where appropriate.`;
    case 'missingLanguage': return `Check the language of the visible content on ${url}, then set its matching <html lang> value. The scan did not establish a valid document language.`;
    case 'answerHeading': return `At ${url}, review the section immediately below ${quote(p.heading)}. No adjacent paragraph, list or table answer was captured. If the answer is absent, add a direct answer using verified page facts; inspect existing wrappers before duplicating content.`;
    case 'linkAnchor': return `At ${url}, replace the observed label ${quote(p.anchor)} linking to ${p.target} with the destination's actual subject. Open that destination first; its content was not verified.`;
    case 'imageAlt': return `Review image ${p.src} on ${url}. Describe its actual visual purpose in alt text if informative, or use alt="" if decorative. The image's visual content was not inspected; no description has been invented.`;
    default: return null;
  }
}

export function pageActions(evidence) {
  return (evidence?.findings || []).map(finding => ({ ...finding, action: evidenceAction(finding,evidence) })).filter(f => f.action);
}

// Preserve heuristic scores but stop presenting a fixed checklist as a page-specific fix.
export function contextualizeAudit(audit, page) {
  const evidence = page?.contentEvidence, url = page?.resolvedUrl || evidence?.url;
  const actions = pageActions(evidence);
  for (const metric of audit?.metrics || []) {
    if (metric.passed !== false) continue;
    const name = metric.metric || '';
    let action = null;
    const code = /title/i.test(name) ? 'missingTitle' : /description/i.test(name) ? 'missingDescription' : /heading/i.test(name) ? 'missingH1' : /alt/i.test(name) ? 'imageAlt' : null;
    if (code) action = actions.filter(x => x.code===code || code==='missingH1' && x.code==='multipleH1').slice(0,3).map(x=>x.action).join(' ') || null;
    if (!action && /title/i.test(name) && page.title) action = `Review the current title ${quote(page.title)} on ${url}. The score uses a length heuristic; rewrite only if it fails to describe ${quote(evidence?.topic || page.title)} accurately, not to meet a fixed character target.`;
    if (!action && /description/i.test(name) && page.metaDescription) action = `Review the current description ${quote(page.metaDescription)} on ${url} against ${quote(evidence?.topic || page.title)}. Retain accurate useful copy; a length heuristic alone does not establish a poor snippet.`;
    if (/internal link/i.test(name) && !/broken/i.test(name)) action = (evidence?.internalLinkOpportunities || []).slice(0,3).map(x=>`At ${url}, consider a content link to ${x.url} near the observed terms ${x.matchedTerms.map(quote).join(', ')}. The existing label is ${quote(x.anchor)}; verify the destination is relevant before adding it.`).join(' ') || null;
    if (/dimensions|filenames|modern image|lazy loading/i.test(name)) {
      const images = (page.images || []).filter(x => /dimensions/i.test(name) ? !x.width || !x.height : /filenames/i.test(name) ? !x.hasFilenameContext : /modern/i.test(name) ? !x.isModernFormat : x.loading!=='lazy').slice(0,3);
      const targets = images.map(x=>text(x.src)).filter(Boolean).join(', ');
      if (targets) action = /dimensions/i.test(name) ? `On ${url}, inspect ${targets}; set width and height from each image's real intrinsic dimensions. No dimensions were inferred.` : /lazy/i.test(name) ? `On ${url}, inspect the placement of ${targets}. Lazy-load only images confirmed below the initial viewport; do not lazy-load the main/LCP image.` : /modern/i.test(name) ? `Compare optimized WebP/AVIF output against ${targets} on ${url}; preserve quality and update references only if the measured file size improves.` : `Review filenames for ${targets} on ${url}; rename only to match the actual image subject, then update every reference. Visual contents are unverified.`;
    }
    metric.recommendation = action;
    metric.recommendationBasis = action ? 'Observed page evidence; editorial review required.' : 'No specific fix established from this scan. The heuristic score alone is not a requirement to add content, entities or schema.';
  }
  return audit;
}
