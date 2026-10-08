const ApiResponse = require('../utils/apiResponse');
const { initSse, sendSse, endSse } = require('../utils/sse');
const {
  runAnalyticsChat,
  runManagementBrief,
  runAnalyticsChatStream,
  runManagementBriefStream,
} = require('../services/analyticsAiService');

function attachStreamAbort(req) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  return controller;
}

class AnalyticsAiController {
  static async managementBrief(req, res) {
    try {
      const { start_date, end_date, locale } = req.body || {};
      const data = await runManagementBrief({
        start_date: String(start_date || '').trim(),
        end_date: String(end_date || '').trim(),
        locale: String(locale || 'en').trim().slice(0, 10),
      });
      return ApiResponse.success(res, data, 'Management brief generated');
    } catch (error) {
      console.error('[AnalyticsAI] management-brief error:', error);
      const msg = error?.message || 'Failed to generate management brief';
      const status = /required|invalid/i.test(msg) ? 400 : 500;
      return ApiResponse.error(res, msg, status, msg);
    }
  }

  static async chat(req, res) {
    try {
      const { message, start_date, end_date, locale, history } = req.body || {};
      const msg = String(message || '').trim();
      const data = await runAnalyticsChat({
        message: msg,
        start_date: String(start_date || '').trim(),
        end_date: String(end_date || '').trim(),
        locale: String(locale || 'en').trim().slice(0, 10),
        history: Array.isArray(history) ? history : [],
      });
      return ApiResponse.success(res, data, 'Analytics AI response generated');
    } catch (error) {
      console.error('[AnalyticsAI] chat error:', error);
      const msg = error?.message || 'Failed to generate analytics insights';
      const status = /required|invalid/i.test(msg) ? 400 : 500;
      return ApiResponse.error(res, msg, status, msg);
    }
  }

  static async chatStream(req, res) {
    const abort = attachStreamAbort(req);
    let sseStarted = false;

    try {
      const { message, start_date, end_date, locale } = req.body || {};
      initSse(res);
      sseStarted = true;

      await runAnalyticsChatStream(
        {
          message: String(message || '').trim(),
          start_date: String(start_date || '').trim(),
          end_date: String(end_date || '').trim(),
          locale: String(locale || 'en').trim().slice(0, 10),
        },
        {
          send: (event, data) => {
            if (abort.signal.aborted) return;
            sendSse(res, event, data);
          },
          signal: abort.signal,
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('[AnalyticsAI] chat stream error:', error);
      const msg = error?.message || 'Failed to stream analytics insights';
      if (sseStarted) {
        sendSse(res, 'error', { message: msg });
      } else {
        const status = /required|invalid/i.test(msg) ? 400 : 500;
        return ApiResponse.error(res, msg, status, msg);
      }
    } finally {
      if (sseStarted) endSse(res);
    }
  }

  static async managementBriefStream(req, res) {
    const abort = attachStreamAbort(req);
    let sseStarted = false;

    try {
      const { start_date, end_date, locale } = req.body || {};
      initSse(res);
      sseStarted = true;

      await runManagementBriefStream(
        {
          start_date: String(start_date || '').trim(),
          end_date: String(end_date || '').trim(),
          locale: String(locale || 'en').trim().slice(0, 10),
        },
        {
          send: (event, data) => {
            if (abort.signal.aborted) return;
            sendSse(res, event, data);
          },
          signal: abort.signal,
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('[AnalyticsAI] management-brief stream error:', error);
      const msg = error?.message || 'Failed to stream management brief';
      if (sseStarted) {
        sendSse(res, 'error', { message: msg });
      } else {
        const status = /required|invalid/i.test(msg) ? 400 : 500;
        return ApiResponse.error(res, msg, status, msg);
      }
    } finally {
      if (sseStarted) endSse(res);
    }
  }
}

module.exports = AnalyticsAiController;
