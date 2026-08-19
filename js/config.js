/* 乒乓球 AI 动作评分系统 - 纯浏览器版核心逻辑
   模块：姿态提取(MediaPipe WASM) / 动作分割 / DTW评分 / 段位成长 / 教练反馈 / 实时摄像头评分

   变更说明（2026-08）：
   1) 删除"按段位自适应调整评分严格度"的机制——此前低段位用户使用宽松 k 值，
      动作不规范也会显示异常高分，造成误导。现在所有用户统一使用按真实数据
      校准的固定 k 值（SCORE_K = 50），分数横向可比。段位系统仅保留为
      成长轨迹与教练寄语，不再影响评分本身。
   2) 新增实时评分模式：申请摄像头权限后逐帧检测姿态，在线跟踪肘部速度，
      挥拍结束后立即（毫秒级）完成 DTW 比对并给出分数与纠正建议。

   开源借鉴标注：
   - 实时检测循环（requestAnimationFrame + detectForVideo + video.currentTime
     去重守卫）参考 Google 官方 MediaPipe tasks-vision pose_landmarker
     Web 示例（Apache-2.0）：
     https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/pose_landmarker
   - 摄像头实时姿态反馈的产品形态参考 ergoSmart（MediaPipe Pose 实时网络摄像头
     姿态教练）：https://github.com/princesinghrajput/ergoSmart
   - 肘部速度峰值定位击球时刻 + 关节角度序列 DTW 比对评分的思路，与
     Lyu et al. 2025（Frontiers in Sports and Active Living, MediaPipe 乒乓球
     正手生物力学量化框架）及 LearnOpenCV《AI Fitness Trainer》一致。
   以上仅为思路/模式借鉴，代码均为本项目自研实现。 */

"use strict";

// ---------- 配置 ----------
const JOINTS = ["left_elbow_angle", "right_elbow_angle",
                "left_shoulder_angle", "right_shoulder_angle",
                "left_knee_angle", "right_knee_angle"];
const LM = { nose:0, left_shoulder:11, right_shoulder:12, left_elbow:13, right_elbow:14,
             left_wrist:15, right_wrist:16, left_hip:23, right_hip:24,
             left_knee:25, right_knee:26, left_ankle:27, right_ankle:28 };
const ANGLE_DEFS = {
  left_elbow_angle: ["left_shoulder","left_elbow","left_wrist"],
  right_elbow_angle: ["right_shoulder","right_elbow","right_wrist"],
  left_shoulder_angle: ["left_hip","left_shoulder","left_elbow"],
  right_shoulder_angle: ["right_hip","right_shoulder","right_elbow"],
  left_knee_angle: ["left_hip","left_knee","left_ankle"],
  right_knee_angle: ["right_hip","right_knee","right_ankle"],
};
const WEIGHTS = { left_elbow_angle:0.08, right_elbow_angle:0.22,
                  left_shoulder_angle:0.10, right_shoulder_angle:0.20,
                  left_knee_angle:0.20, right_knee_angle:0.20 };
const FB_RULES = {
  right_elbow_angle: [10,20,"持拍臂肘部伸展幅度与标准偏差较大，注意击球瞬间手臂充分伸展"],
  left_elbow_angle:  [10,20,"非持拍臂配合偏差较大，注意保持平衡姿态"],
  right_shoulder_angle:[10,20,"持拍侧转体幅度不足/过大，引拍时注意腰腹带动转体"],
  left_shoulder_angle: [10,20,"随挥侧肩部偏差较大，注意肩线整体转动"],
  right_knee_angle:  [12,25,"右腿弯曲程度不稳定，注意保持重心下沉"],
  left_knee_angle:   [12,25,"左腿弯曲程度不稳定，注意保持重心下沉"],
};
const JOINT_CN = { right_elbow_angle:"右肘", left_elbow_angle:"左肘",
  right_shoulder_angle:"右肩", left_shoulder_angle:"左肩",
  right_knee_angle:"右膝", left_knee_angle:"左膝" };

/* 评分严格度：固定 k，按真实数据校准（同类动作互评≈70-80分，明显错误动作<60分）。
   不再按段位调整——所有用户同一把尺子，分数才可比、可追踪。 */
const SCORE_K = 50.0;

/* 段位仅用于成长轨迹与教练寄语，不影响评分严格度（已删除各段位独立的 k 值）。 */
const TIERS = [
  {name:"青铜", std:25, minAvg:0,  focus:["left_knee_angle","right_knee_angle","left_shoulder_angle"],
   motto:"先把根基打牢：站稳、屈膝、重心下沉", next:"升级关键：保持膝盖弯曲、重心稳定"},
  {name:"白银", std:18, minAvg:55, focus:["right_shoulder_angle","left_shoulder_angle","right_knee_angle"],
   motto:"开始用身体打球：转体带动手臂", next:"升级关键：引拍时充分转体，用腰腹带动挥拍"},
  {name:"黄金", std:12, minAvg:62, focus:["right_elbow_angle","right_shoulder_angle"],
   motto:"动作框架已成型，雕琢发力链条", next:"升级关键：击球瞬间手臂充分伸展，发力从脚到腰到手一气呵成"},
  {name:"铂金", std:8,  minAvg:70, focus:["right_elbow_angle","left_elbow_angle","right_shoulder_angle"],
   motto:"细节决定上限：一致性比爆发更重要", next:"升级关键：每一次挥拍的角度曲线都要稳定复现"},
  {name:"大师", std:5,  minAvg:78, focus:["right_elbow_angle","left_elbow_angle"],
   motto:"精益求精，向教科书级动作对齐", next:"保持：与精英模板的逐帧偏差控制在个位数"},
];
const PLACEMENT = 3, DEMOTE_SHIELD = 3;
const LR_PAIRS = [["left_shoulder","right_shoulder"],["left_elbow","right_elbow"],
  ["left_wrist","right_wrist"],["left_hip","right_hip"],["left_knee","right_knee"],
  ["left_ankle","right_ankle"]];
const LR_ANGLES = [["left_elbow_angle","right_elbow_angle"],
  ["left_shoulder_angle","right_shoulder_angle"],["left_knee_angle","right_knee_angle"]];

/* 实时模式参数 */
const LIVE = {
  bufferSec: 3.0,        // 滚动缓冲时长（覆盖 引拍0.8s + 随挥0.6s + 余量）
  preSec: 0.8, postSec: 0.6,   // 挥拍段截取窗口（与离线分割一致）
  endRatio: 0.45,        // 速度回落至峰值比例以下判定随挥结束
  endHoldSec: 0.15,      // 需持续低于该比例的时间
  cooldownSec: 0.6,      // 两次评分之间的冷却（支持连续挥拍，峰值间隔通常>1s）
  minPeakSpeed: 1.6,     // 峰值速度下限（归一化坐标/秒），过滤走动噪音
  warmupSec: 1.5,        // 摄像头开启后的预热期，期间不触发
  readyHoldSec: 0.8,     // 首次就位：全身入镜且站定持续时间（仅需一次，之后锁存）
  armLostSec: 1.5,       // 人体丢失超过该时长后才解除就绪，回到首次就位流程
  triggerRatio: 0.7,     // 上升沿触发：速度从阈值×该比例以下冲到阈值以上才算新挥拍
  maxHipDrift: 0.18,     // 挥拍段内髋部横移上限，超过判为走动/调整位置
};

// TEMPLATES 在 templates.js 中定义（纯数据，先于本文件加载）
const $ = id => document.getElementById(id);
const setStatus = t => $("status").textContent = t;
