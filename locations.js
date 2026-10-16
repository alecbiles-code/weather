// Shared location and model lists, used by the site (app.js, map.js) and by scripts/.
// Coordinates and elevations are carried over unchanged from Powcast v2.
const ORIGINAL_LOCATIONS = [
  {name:'Vail',lat:39.6403,lon:-106.3742,elev:12408,region:'Central',kind:'resort',snotel:'842:CO:SNTL',acres:5289,vertical:3450,base:8120,top:11570,lifts:31,avgSnow:354},
  {name:'Beaver Creek',lat:39.6042,lon:-106.5165,elev:11440,region:'Central',kind:'resort',snotel:'1041:CO:SNTL',acres:1832,vertical:3340,base:8100,top:11440,lifts:24,avgSnow:325},
  {name:'Breckenridge',lat:39.4817,lon:-106.0384,elev:12998,region:'Central',kind:'resort',snotel:'415:CO:SNTL',acres:2908,vertical:3398,base:9600,top:12998,lifts:35,avgSnow:366},
  {name:'Keystone',lat:39.6069,lon:-105.9439,elev:12408,region:'Central',kind:'resort',snotel:'505:CO:SNTL',acres:3148,vertical:3128,base:9280,top:12408,lifts:20,avgSnow:235},
  {name:'Copper Mountain',lat:39.5022,lon:-106.1511,elev:12313,region:'Central',kind:'resort',snotel:'415:CO:SNTL',acres:2507,vertical:2601,base:9712,top:12313,lifts:24,avgSnow:282},
  {name:'Arapahoe Basin',lat:39.6425,lon:-105.8717,elev:13050,region:'Central',kind:'resort',snotel:'505:CO:SNTL',acres:1428,vertical:2530,base:10780,top:13050,lifts:9,avgSnow:350},
  {name:'Winter Park',lat:39.8868,lon:-105.7625,elev:12060,region:'Front Range',kind:'resort',snotel:'1186:CO:SNTL',acres:3081,vertical:3060,base:9000,top:12060,lifts:25,avgSnow:347},
  {name:'Steamboat',lat:40.4572,lon:-106.8045,elev:10568,region:'Northern',kind:'resort',snotel:'457:CO:SNTL',acres:2965,vertical:3668,base:6900,top:10568,lifts:23,avgSnow:368},
  {name:'Aspen Snowmass',lat:39.2084,lon:-106.9490,elev:12510,region:'Western',kind:'resort',snotel:'669:CO:SNTL',acres:5517,vertical:4406,base:8104,top:12510,lifts:42,avgSnow:300},
  {name:'Telluride',lat:37.9375,lon:-107.8123,elev:13150,region:'Southern',kind:'resort',snotel:'1344:CO:SNTL',acres:2000,vertical:4425,base:8725,top:13150,lifts:19,avgSnow:280},
  {name:'Crested Butte',lat:38.8991,lon:-106.9659,elev:12162,region:'Western',kind:'resort',snotel:'380:CO:SNTL',acres:1547,vertical:2787,base:9375,top:12162,lifts:15,avgSnow:216},
  {name:'Loveland',lat:39.6800,lon:-105.8979,elev:13010,region:'Central',kind:'resort',snotel:'602:CO:SNTL',acres:1800,vertical:2210,base:10800,top:13010,lifts:11,avgSnow:422},
  {name:'Eldora',lat:39.9372,lon:-105.5827,elev:10600,region:'Front Range',kind:'resort',snotel:'564:CO:SNTL',acres:680,vertical:1400,base:9200,top:10600,lifts:10,avgSnow:225},
  {name:'Monarch Mountain',lat:38.5122,lon:-106.3320,elev:11961,region:'Central',kind:'resort',snotel:'701:CO:SNTL',acres:800,vertical:1162,base:10790,top:11961,lifts:7,avgSnow:350},
  {name:'Purgatory',lat:37.6303,lon:-107.8140,elev:10822,region:'Southern',kind:'resort',snotel:'387:CO:SNTL',acres:1635,vertical:2029,base:8793,top:10822,lifts:12,avgSnow:260},
  {name:'Wolf Creek',lat:37.4722,lon:-106.7930,elev:11904,region:'Southern',kind:'resort',snotel:'874:CO:SNTL',acres:1600,vertical:1604,base:10300,top:11904,lifts:9,avgSnow:430},
  {name:'Silverton Mountain',lat:37.8846,lon:-107.6659,elev:13487,region:'Southern',kind:'resort',snotel:'713:CO:SNTL',acres:1819,vertical:3087,base:10400,top:13487,lifts:1,avgSnow:400},
  {name:'Powderhorn',lat:39.0694,lon:-108.1507,elev:9850,region:'Western',kind:'resort',snotel:'622:CO:SNTL',acres:1600,vertical:1650,base:8200,top:9850,lifts:4,avgSnow:250},
  {name:'Sunlight Mountain',lat:39.3998,lon:-107.3387,elev:9895,region:'Western',kind:'resort',snotel:'618:CO:SNTL',acres:730,vertical:2010,base:7885,top:9895,lifts:3,avgSnow:250},
  {name:'Ski Cooper',lat:39.3603,lon:-106.3014,elev:11700,region:'Central',kind:'resort',snotel:'485:CO:SNTL',acres:480,vertical:1200,base:10500,top:11700,lifts:5,avgSnow:250},
  {name:'Berthoud Pass',lat:39.7986,lon:-105.7778,elev:11307,region:'Front Range',kind:'bc',snotel:'335:CO:SNTL'},
  {name:'Loveland Pass',lat:39.6636,lon:-105.8794,elev:11990,region:'Central',kind:'bc',snotel:'505:CO:SNTL'},
  {name:'Vail Pass',lat:39.5303,lon:-106.2175,elev:10662,region:'Central',kind:'bc',snotel:'415:CO:SNTL'},
  {name:'Rabbit Ears Pass',lat:40.4847,lon:-106.6114,elev:9426,region:'Northern',kind:'bc',snotel:'825:CO:SNTL'},
  {name:'Cameron Pass',lat:40.5208,lon:-105.8925,elev:10276,region:'Northern',kind:'bc',snotel:'551:CO:SNTL'},
  {name:'Jones Pass',lat:39.7736,lon:-105.8919,elev:12340,region:'Front Range',kind:'bc',snotel:'970:CO:SNTL'},
  {name:'Independence Pass',lat:39.1089,lon:-106.5639,elev:12095,region:'Western',kind:'bc',snotel:'369:CO:SNTL'},
  {name:'Hoosier Pass',lat:39.3617,lon:-106.0625,elev:11542,region:'Central',kind:'bc',snotel:'531:CO:SNTL'},
  {name:'Monarch Pass',lat:38.4967,lon:-106.3256,elev:11312,region:'Central',kind:'bc',snotel:'701:CO:SNTL'},
  {name:'Wolf Creek Pass',lat:37.4831,lon:-106.8003,elev:10857,region:'Southern',kind:'bc',snotel:'874:CO:SNTL'},
  {name:'Red Mountain Pass',lat:37.8983,lon:-107.7114,elev:11018,region:'Southern',kind:'bc',snotel:'713:CO:SNTL'},
  {name:'Fremont Pass',lat:39.3667,lon:-106.1867,elev:11318,region:'Central',kind:'bc',snotel:'485:CO:SNTL'},
];
const LINKS = {
  'Vail':'https://www.vail.com/', 'Beaver Creek':'https://www.beavercreek.com/', 'Breckenridge':'https://www.breckenridge.com/',
  'Keystone':'https://www.keystoneresort.com/', 'Copper Mountain':'https://www.coppercolorado.com/', 'Arapahoe Basin':'https://www.arapahoebasin.com/',
  'Winter Park':'https://www.winterparkresort.com/', 'Steamboat':'https://www.steamboat.com/', 'Aspen Snowmass':'https://www.aspensnowmass.com/',
  'Telluride':'https://tellurideskiresort.com/', 'Crested Butte':'https://www.skicb.com/', 'Loveland':'https://skiloveland.com/',
  'Eldora':'https://www.eldora.com/', 'Monarch Mountain':'https://skimonarch.com/', 'Purgatory':'https://www.purgatory.ski/',
  'Wolf Creek':'https://wolfcreekski.com/', 'Silverton Mountain':'https://silvertonmountain.com/', 'Powderhorn':'https://www.powderhorn.com/',
  'Sunlight Mountain':'https://sunlightmtn.com/', 'Ski Cooper':'https://www.skicooper.com/'
};
// Official webcam pages, checked 2026-10-14. Silverton Mountain publishes no webcam page.
// Steamboat blocks automated checks; its URL comes from the resort's own search listing.
const WEBCAMS = {
  'Vail': 'https://www.vail.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'Beaver Creek': 'https://www.beavercreek.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'Breckenridge': 'https://www.breckenridge.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'Keystone': 'https://www.keystoneresort.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'Copper Mountain': 'https://www.coppercolorado.com/the-mountain/webcams/',
  'Arapahoe Basin': 'https://www.arapahoebasin.com/mountain-cams/',
  'Winter Park': 'https://www.winterparkresort.com/the-mountain/mountain-cams',
  'Steamboat': 'https://www.steamboat.com/the-mountain/live-cams',
  'Aspen Snowmass': 'https://www.aspensnowmass.com/four-mountains/mountain-cams',
  'Telluride': 'https://tellurideskiresort.com/webcams/',
  'Crested Butte': 'https://www.skicb.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'Loveland': 'https://skiloveland.com/webcams/',
  'Eldora': 'https://www.eldora.com/the-mountain/current-conditions/webcams/',
  'Monarch Mountain': 'https://skimonarch.com/conditions/cams/',
  'Purgatory': 'https://www.purgatory.ski/mountain/weather-conditions-webcams/webcams/',
  'Wolf Creek': 'https://wolfcreekski.com/webcams/',
  'Powderhorn': 'https://www.powderhorn.com/webcams/',
  'Sunlight Mountain': 'https://sunlightmtn.com/explore/mountain-status/#cams',
  'Ski Cooper': 'https://www.skicooper.com/weather-webcams/'
};
export const LOCS = ORIGINAL_LOCATIONS.map(l => ({...l, id: l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), url: LINKS[l.name] || null, webcam: WEBCAMS[l.name] || null}));

// Open-Meteo model ids verified against Colorado coordinates on 2026-10-14.
// km: grid spacing from Open-Meteo's model documentation (checked 2026-10-15).
// Excluded: ids that return no snowfall here (GraphCast, BOM ACCESS, KMA) and regional
// "seamless" ids that silently fall back to ECMWF outside Europe (MET Norway, KNMI, DMI).
export const MODELS = [
  {id: 'ncep_hrrr_conus', km: 3, name: 'HRRR', org: 'NOAA', kind: 'High-res regional', note: '3 km, about 48 h', about: "NOAA's 3 km model, rerun every hour. Sees individual ridges and storm timing best, but only 2 days out."},
  {id: 'ncep_nam_conus', km: 3, name: 'NAM', org: 'NOAA', kind: 'High-res regional', note: '3 km CONUS nest, 60 h', about: "NOAA's other 3 km model. Similar detail to HRRR, updated every 6 hours, 2.5 days out."},
  {id: 'cmc_gem_rdps', km: 10, name: 'GEM Regional', org: 'Environment Canada', kind: 'Regional', note: 'RDPS, about 3.5 days', about: "Canada's regional model. Mid-resolution view of the next 3 to 4 days."},
  {id: 'ncep_nbm_conus', km: 2.5, name: 'NBM', org: 'NOAA', kind: 'Statistical blend', note: 'National Blend of Models, 2.5 km', about: "NOAA's blend of many models with bias correction; the National Weather Service's starting point. Its snowfall uses variable snow ratios, so it often reads higher."},
  {id: 'ncep_gfs_global', km: 13, name: 'GFS', org: 'NOAA', kind: 'Global', note: '16 days', about: "NOAA's flagship global model. The workhorse for days 3 to 16."},
  {id: 'ecmwf_ifs', km: 9, name: 'ECMWF IFS', org: 'ECMWF', kind: 'Global', note: 'HRES 9 km, 15 days', about: "The European model at 9 km. Usually the most accurate global model in published verification."},
  {id: 'ecmwf_aifs025_single', km: 28, name: 'ECMWF AIFS', org: 'ECMWF', kind: 'Global AI', note: 'Machine-learning model, 0.25°', about: "ECMWF's machine-learning model, trained on decades of its own analyses."},
  {id: 'dwd_icon_global', km: 11, name: 'ICON', org: 'DWD Germany', kind: 'Global', note: 'About 7.5 days', about: "Germany's global model."},
  {id: 'cmc_gem_gdps', km: 15, name: 'GEM Global', org: 'Environment Canada', kind: 'Global', note: 'GDPS, 10 days', about: "Canada's global model."},
  {id: 'ukmo_global_deterministic_10km', km: 10, name: 'UKMO', org: 'UK Met Office', kind: 'Global', note: '10 km, about 7 days', about: "The UK Met Office global model at 10 km."},
  {id: 'jma_gsm', km: 55, name: 'JMA GSM', org: 'Japan Meteorological Agency', kind: 'Global', note: 'About 11 days', about: "Japan's global model. Coarse grid, so mountains are smoothed out."},
  {id: 'meteofrance_arpege_world', km: 25, name: 'ARPEGE', org: 'Météo-France', kind: 'Global', note: 'About 4 days', about: "Meteo-France's global model, 4 days out."},
  {id: 'cma_grapes_global', km: 15, name: 'CMA GRAPES', org: 'China Meteorological Administration', kind: 'Global', note: 'About 5 days', about: "China's global model, about 5 days out."},
  {id: 'ncep_aigfs025', km: 25, name: 'AIGFS', org: 'NOAA', kind: 'Global AI', note: 'Machine-learning GFS, 0.25°, 16 days', about: "NOAA's machine-learning version of GFS."},
];
