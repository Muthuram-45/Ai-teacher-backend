const express = require('express');
const router = express.Router();
const analyticsController = require('../Controllers/analyticsController');

// Get list of topics and dates
router.get('/courses', analyticsController.getCourses);
router.get('/topics', analyticsController.getTopics);
router.get('/subtopics', analyticsController.getSubTopics);
router.get('/dates', analyticsController.getDates);

// Dashboard Overview KPIs
router.get('/overview', analyticsController.getOverview);

// Trend and Comparison charts
router.get('/topic/:topic/trend', analyticsController.getTopicTrend);
router.get('/topic-comparison', analyticsController.getTopicComparison);
router.get('/learning-journey', analyticsController.getLearningJourney);
router.get('/sub-topic', analyticsController.getSubTopicPerformance);

// Quiz and Engagement Stats
router.get('/quiz-stats', analyticsController.getQuizStats);
router.get('/engagement-stats', analyticsController.getEngagementStats);
router.get('/engagement', analyticsController.getEngagementStats); // Alias for frontend call

// Student Performance
router.get('/students', analyticsController.getStudents);
router.get('/student-progress', analyticsController.getStudentProgress);

// Detailed / Tab-specific
router.get('/sessions', analyticsController.getSessions);
router.get('/recent-classes', analyticsController.getRecentClasses);
router.get('/activity-breakdown', analyticsController.getActivityBreakdown);

// Admin Portal - Meeting-Centric & Consolidated Endpoints
router.get('/admin-meetings', analyticsController.getAdminMeetings);
router.get('/meeting-consolidated', analyticsController.getMeetingConsolidated);

module.exports = router;
