// ============================================================
// DAILY FOUNDER CALL BRIEFING — Google Apps Script v4
// Flow: Company website → Claude API → Google CSE (LinkedIn only)
// ============================================================
// SETUP:
//   1. Script Properties (Project Settings → Script Properties):
//      - ANTHROPIC_API_KEY   (required — from console.anthropic.com)
//      - GOOGLE_CSE_API_KEY  (optional — for LinkedIn links)
//      - GOOGLE_CSE_ID       (optional — for LinkedIn links)
//
//   2. If using Google CSE for LinkedIn profile links:
//      Programmable Search Engine → create with: linkedin.com/*
//      Google Cloud → enable "Custom Search API" in same project
//
//   3. Set a time-driven trigger on `main` (daily, 8–9 AM)
//   4. Run `main` once manually to authorize Calendar + Gmail
// ============================================================

// --------------- CONFIGURATION ---------------

var CONFIG = {
  RECIPIENT_EMAIL: "zi@scopvc.com",
  INTERNAL_DOMAIN: "scopvc.com",
  KNOWN_INTERNALS: ["mtucker@scopvc.com", "zi@scopvc.com", "ziang.pan@scopvc.com"],
  SEND_IF_NO_CALLS: false,
  CLAUDE_MODEL: "claude-sonnet-4-6",
  PERSONAL_DOMAINS: [
    "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com",
    "outlook.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "live.com", "msn.com", "protonmail.com", "proton.me", "hey.com"
  ]
};

// --------------- MAIN ---------------

function main() {
  var today = new Date();
  var day = today.getDay();
  if (day === 0 || day === 6) {
    Logger.log("Weekend — skipping.");
    return;
  }

  Logger.log("Starting daily briefing for " + today.toDateString());

  var founderCalls = getFounderCalls(today);
  Logger.log("Found " + founderCalls.length + " founder call(s).");

  if (founderCalls.length === 0) {
    if (CONFIG.SEND_IF_NO_CALLS) {
      sendNoCalls(today);
    } else {
      Logger.log("No founder calls today. Skipping email.");
    }
    return;
  }

  var briefings = [];
  for (var i = 0; i < founderCalls.length; i++) {
    try {
      var briefing = buildBriefing(founderCalls[i]);
      briefings.push(briefing);
    } catch (err) {
      Logger.log("Error for " + founderCalls[i].title + ": " + err);
      briefings.push({
        time: founderCalls[i].timeStr,
        title: founderCalls[i].title,
        error: true,
        errorMsg: err.toString()
      });
    }
  }

  sendBriefingEmail(today, briefings);
  Logger.log("Briefing email sent.");
}

// --------------- CALENDAR PARSING ---------------

function getFounderCalls(date) {
  var calendar = CalendarApp.getDefaultCalendar();
  var startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  var endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
  var events = calendar.getEvents(startOfDay, endOfDay);
  var founderCalls = [];

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (event.isAllDayEvent()) continue;
    var myStatus = event.getMyStatus();
    if (myStatus === CalendarApp.GuestStatus.NO) continue;

    var attendees = event.getGuestList();
    if (attendees.length === 0) continue;

    var externalAttendees = [];
    for (var j = 0; j < attendees.length; j++) {
      var email = attendees[j].getEmail().toLowerCase();
      if (email.endsWith("@" + CONFIG.INTERNAL_DOMAIN)) continue;
      if (CONFIG.KNOWN_INTERNALS.indexOf(email) !== -1) continue;
      externalAttendees.push({
        email: email,
        name: attendees[j].getName() || email.split("@")[0]
      });
    }

    if (externalAttendees.length === 0) continue;

    var startTime = event.getStartTime();
    var timeStr = Utilities.formatDate(startTime, Session.getScriptTimeZone(), "h:mm a");
    founderCalls.push({
      title: event.getTitle(),
      startTime: startTime,
      timeStr: timeStr,
      founders: externalAttendees
    });
  }

  founderCalls.sort(function(a, b) { return a.startTime - b.startTime; });
  return founderCalls;
}

// --------------- RESEARCH + BRIEFING ---------------
// Flow: 1. Fetch company website directly
//       2. Claude synthesizes (using website content + its own knowledge)
//       3. Google CSE finds LinkedIn profile URLs (optional fallback)

function buildBriefing(call) {
  var founders = call.founders;
  var primaryEmail = founders[0].email;
  var domain = primaryEmail.split("@")[1];
  var isPersonalDomain = CONFIG.PERSONAL_DOMAINS.indexOf(domain) !== -1;
  var companyName = isPersonalDomain
    ? call.title
    : domain.replace(/\.\w+$/, "");
  var founderNames = founders.map(function(f) { return f.name; }).join(", ");

  // --- STEP 1: Fetch company website directly ---
  var websiteContent = "";

  if (!isPersonalDomain) {
    // Try homepage
    var homepage = fetchWebsiteText("https://" + domain);
    if (homepage) {
      websiteContent += "=== HOMEPAGE (" + domain + ") ===\n" + homepage + "\n\n";
    }
    // Try common subpages (often work even when homepage is JS-heavy)
    var subpages = ["/about", "/about-us", "/team", "/company", "/products", "/solutions"];
    for (var i = 0; i < subpages.length; i++) {
      var sub = fetchWebsiteText("https://" + domain + subpages[i]);
      if (sub && sub.length > 100) {
        websiteContent += "=== " + domain + subpages[i] + " ===\n" + sub + "\n\n";
        break;
      }
    }
  }

  // --- STEP 2: Claude synthesizes company + tries founder bios ---
  var claudeResult = callClaude(call.title, companyName, domain, founderNames, websiteContent);

  // --- STEP 3: Build founder info — Claude first, CSE fallback ---
  var claudeBios = claudeResult.founder_bios || [];
  var founderInfo = [];

  for (var j = 0; j < founders.length; j++) {
    var f = founders[j];

    // Check if Claude returned a useful bio for this founder
    var claudeBio = null;
    for (var k = 0; k < claudeBios.length; k++) {
      // Match by name (case-insensitive, partial match)
      if (claudeBios[k].name && f.name &&
          claudeBios[k].name.toLowerCase().indexOf(f.name.toLowerCase().split(" ")[0]) !== -1) {
        claudeBio = claudeBios[k];
        break;
      }
    }

    var hasBio = claudeBio && claudeBio.bio && claudeBio.bio !== "N/A" && claudeBio.bio.length > 5;

    // If Claude had no bio, fall back to Google CSE for LinkedIn
    var linkedInUrl = null;
    if (!hasBio) {
      Logger.log("No Claude bio for " + f.name + " — trying Google CSE for LinkedIn.");
      linkedInUrl = findLinkedInProfile(f.name, companyName);
    }

    founderInfo.push({
      name: f.name,
      email: f.email,
      bio: hasBio ? claudeBio.bio : null,
      linkedIn: linkedInUrl
    });
  }

  return {
    time: call.timeStr,
    title: call.title,
    companySummary: claudeResult.company_summary,
    keyTerms: claudeResult.key_terms,
    founders: founderInfo,
    error: false
  };
}

// --------------- LINKEDIN PROFILE FINDER ---------------

function findLinkedInProfile(personName, companyName) {
  // Search for their LinkedIn profile via Google Custom Search
  // CSE is already restricted to linkedin.com etc., so just search by name
  var query = personName + " " + companyName + " linkedin";
  var results = customSearchRaw(query, 3);

  if (!results || results.length === 0) return null;

  // Find the first result that's actually a linkedin.com/in/ URL
  for (var i = 0; i < results.length; i++) {
    var url = results[i].link || "";
    if (url.indexOf("linkedin.com/in/") !== -1) {
      return url;
    }
  }
  return null;
}

// --------------- WEB FETCHER ---------------

function fetchWebsiteText(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (response.getResponseCode() !== 200) return null;

    var html = response.getContentText();

    // Extract meta tags first (work even on JS-heavy sites)
    var meta = "";
    var m1 = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (m1) meta += m1[1] + "\n";
    var m2 = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (m2) meta += m2[1] + "\n";
    var m3 = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m3) meta += m3[1] + "\n";

    // Strip non-content elements
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
    html = html.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
    html = html.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
    html = html.replace(/<header[\s\S]*?<\/header>/gi, " ");
    html = html.replace(/<[^>]+>/g, " ");
    html = html.replace(/&nbsp;/g, " ");
    html = html.replace(/\s+/g, " ").trim();

    var combined = meta + html;
    if (combined.trim().length < 100) {
      return meta.length > 10 ? meta : null;
    }
    return combined.substring(0, 4000);
  } catch (err) {
    Logger.log("Fetch failed: " + url + " — " + err);
    return null;
  }
}

// --------------- GOOGLE CUSTOM SEARCH ---------------

// Returns formatted string for Claude prompt
function customSearch(query) {
  var items = customSearchRaw(query, 5);
  if (!items || items.length === 0) return null;

  var results = [];
  for (var i = 0; i < items.length; i++) {
    results.push(
      "TITLE: " + items[i].title
      + "\nURL: " + items[i].link
      + "\nSNIPPET: " + (items[i].snippet || "")
    );
  }
  return results.join("\n\n");
}

// Returns raw array of search result objects
function customSearchRaw(query, num) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty("GOOGLE_CSE_API_KEY");
  var cseId = props.getProperty("GOOGLE_CSE_ID");

  if (!apiKey || !cseId) {
    Logger.log("Google CSE not configured — search skipped for: " + query);
    return null;
  }

  try {
    var url = "https://www.googleapis.com/customsearch/v1"
      + "?key=" + encodeURIComponent(apiKey)
      + "&cx=" + encodeURIComponent(cseId)
      + "&q=" + encodeURIComponent(query)
      + "&num=" + (num || 5);

    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log("CSE error (" + response.getResponseCode() + "): " + response.getContentText().substring(0, 500));
      return null;
    }

    var data = JSON.parse(response.getContentText());
    return (data.items && data.items.length > 0) ? data.items : null;
  } catch (err) {
    Logger.log("CSE error: " + err);
    return null;
  }
}

// --------------- CLAUDE API ---------------

function callClaude(meetingTitle, companyName, domain, founderNames, websiteContent) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not found in Script Properties.");
  }

  var hasWebsite = websiteContent && websiteContent.trim().length > 50;

  var prompt = 'You are a research assistant for a VC investor preparing for founder calls.\n\n'
    + 'MEETING: ' + meetingTitle + '\n'
    + 'COMPANY NAME: ' + companyName + '\n'
    + 'COMPANY DOMAIN: ' + domain + '\n'
    + 'FOUNDERS: ' + founderNames + '\n\n';

  if (hasWebsite) {
    prompt += 'WEBSITE CONTENT (scraped from ' + domain + '):\n' + websiteContent + '\n\n';
  }

  prompt += 'INSTRUCTIONS:\n'
    + 'Use the website content above as your PRIMARY source. Then supplement with your own knowledge about this company, its industry, founders, and market.\n\n'
    + (hasWebsite ? '' : 'No website content was available (site may be JS-rendered). Rely on your own knowledge of this company and domain.\n\n')
    + 'Return STRICT JSON only — no markdown, no code fences, no extra text:\n'
    + '{\n'
    + '  "company_summary": "3-4 sentences: what the company does, target market/industry, stage, and any notable traction or funding.",\n'
    + '  "founder_bios": [\n'
    + '    { "name": "Full Name", "bio": "Education + career highlights (last 10 yrs). If unknown, write exactly: N/A" }\n'
    + '  ],\n'
    + '  "key_terms": [\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." },\n'
    + '    { "term": "Term", "definition": "1-2 sentence definition." }\n'
    + '  ]\n'
    + '}\n\n'
    + 'RULES:\n'
    + '- Do NOT include Zi Pan or Ziang Pan in founder_bios.\n'
    + '- company_summary: prioritize website content, then your own knowledge. Be direct — no hedging, no "based on available information" phrasing.\n'
    + '- founder_bios: use your knowledge of these people. Include education (degree, school) and recent career (Role, Company, Years). If you truly don\'t know, write exactly "N/A" — nothing more.\n'
    + '- key_terms: 3 terms specific to this company\'s industry or technical space that a generalist VC investor might not know. NOT generic business terms like "TAM", "ARR", "SaaS".\n'
    + '- Return ONLY the JSON object.';

  var payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", options);
  if (response.getResponseCode() !== 200) {
    Logger.log("Claude error (" + response.getResponseCode() + "): " + response.getContentText());
    throw new Error("Claude API returned " + response.getResponseCode());
  }

  var result = JSON.parse(response.getContentText());
  var text = result.content[0].text;

  try {
    var cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    Logger.log("Claude JSON parse failed: " + text);
    throw new Error("Claude returned invalid JSON.");
  }
}

// --------------- EMAIL COMPOSER ---------------

function sendBriefingEmail(date, briefings) {
  var dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM d, yyyy");
  var subject = "Founder Call Briefing — " + dateStr;

  var html = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">'
    + '<h1 style="font-size: 22px; font-weight: 600; border-bottom: 2px solid #2563eb; padding-bottom: 8px; margin-bottom: 24px;">'
    + 'Founder Call Briefing — ' + dateStr + '</h1>';

  for (var i = 0; i < briefings.length; i++) {
    var b = briefings[i];

    if (b.error) {
      html += '<div style="margin-bottom: 32px; padding: 16px; background: #fef2f2; border-left: 4px solid #ef4444;">'
        + '<h2 style="font-size: 18px; margin: 0;">' + b.time + ' — ' + b.title + '</h2>'
        + '<p style="color: #991b1b; margin: 8px 0 0 0;">Could not generate briefing: ' + b.errorMsg + '</p></div>';
      continue;
    }

    // Founders — show bio if Claude found one, otherwise LinkedIn link, otherwise N/A
    var foundersHtml = "";
    for (var j = 0; j < b.founders.length; j++) {
      var f = b.founders[j];
      if (f.bio) {
        // Claude had info — show bio, plus LinkedIn link if we also found one
        var linkedInSuffix = f.linkedIn
          ? ' (<a href="' + f.linkedIn + '" style="color: #2563eb;">LinkedIn</a>)'
          : '';
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + ':</strong> '
          + f.bio + linkedInSuffix + '</p>';
      } else if (f.linkedIn) {
        // No bio but found LinkedIn — show link so user can look them up
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + '</strong> '
          + '(<a href="' + f.linkedIn + '" style="color: #2563eb;">LinkedIn</a>)</p>';
      } else {
        // Nothing found
        foundersHtml += '<p style="margin: 4px 0;"><strong>' + f.name + '</strong> — N/A</p>';
      }
    }

    // Key terms
    var termsHtml = "";
    if (b.keyTerms && b.keyTerms.length > 0) {
      for (var k = 0; k < b.keyTerms.length; k++) {
        var kt = b.keyTerms[k];
        termsHtml += '<p style="margin: 4px 0;"><strong>' + (k + 1) + '. ' + kt.term + '</strong> — ' + kt.definition + '</p>';
      }
    }

    html += '<div style="margin-bottom: 32px;">'
      + '<h2 style="font-size: 18px; color: #2563eb; margin: 0 0 12px 0;">' + b.time + ' — ' + b.title + '</h2>'
      // Company
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Company</h3>'
      + '<p style="margin: 0; line-height: 1.5;">' + b.companySummary + '</p>'
      + '</div>'
      // Founders
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Founders</h3>'
      + foundersHtml
      + '</div>'
      // Key Terms
      + '<div style="margin-bottom: 12px;">'
      + '<h3 style="font-size: 13px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px 0;">Key Terms</h3>'
      + termsHtml
      + '</div>'
      + '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">'
      + '</div>';
  }

  html += '<p style="font-size: 12px; color: #9ca3af; text-align: center; margin-top: 32px;">'
    + 'Generated by ScOp Daily Briefing</p></div>';

  GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, subject, "View this email in HTML.", {
    htmlBody: html
  });
}

function sendNoCalls(date) {
  var dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM d, yyyy");
  GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, "Founder Call Briefing — " + dateStr, "No founder calls on your calendar today.");
}
