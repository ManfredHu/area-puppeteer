// 格式化数据
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const ora = require('ora');
const chalk = require('chalk');
const awaitTo = require('async-await-error-handling');
const { is } = require('hu-tool');
const { timeout, writeFileSync } = require('./utils');

const provinces = require('./provinces');
const cities = require('./cities');
const areas = require('./areas');
const pcodes = Object.keys(provinces['100000']);

/** 
 * 四个直辖市会将「市辖区」作为二级行政区域
 * 重庆市会将「县」作为二级行政区域
 * 河北省/河南省/湖北省/海南省 等省份会将「省直辖县级行政区划」作为第二级行政区域
 * 新疆会将「自治区直辖县级行政区划」作为第二级行政区域
 * 出于实用性考虑，省市联动会过滤掉这些，直接用第二级行政区域补充
*/
const filter = ['市辖区', '县', '省直辖县级行政区划', '自治区直辖县级行政区划'];

// 省市
const pca = {
    '100000': provinces['100000']
};
// 删除港澳
delete pca['100000']['910000'];

// 省市区
const pcaa = {
    '100000': provinces['100000']
};

// 提取行政区域 code
const reg = /0(?=0{2,})/;
const target = 'http://www.stats.gov.cn/tjsj/tjbz/tjyqhdmhcxhfdm/2018/#{route}.html';

const spinner = ora({
    color: 'yellow'
});


function formatCode (code, text = '') {
    // 特殊处理东莞市和中山市的县区数据 code
    if(text === '东莞市' || text === '中山市') {
        return code.slice(0, -3);
    }
    const index = reg.exec(code)['index'];
    return index > 6 ? code.slice(0, index) : code.slice(0, 6);
}

// 省市联动
function formatPCAddress () {
    pcodes.forEach(pcode => {
        if (pcode === '710000') {
            // 台湾
            pca[pcode] = provinces['710100'];
        } else if (pcode === '910000') {
            // 港澳
            pca['100000']['810000'] = '香港特别行政区';
            pca['100000']['820000'] = '澳门特别行政区';
            pca['810000'] = provinces['810000'];
            pca['820000'] = provinces['820000'];
        } else {
            const res = {};
            // 当前省对应的城市列表
            const pcities = cities.filter(city => city.parentCode === pcode);
            pcities.forEach(city => {
                // 如果城市名字为包含 '市辖区', '县', '省直辖县级行政区划', '自治区直辖县级行政区划' 四个则用第三级区域数据补充
                // 如北京天津下面直接到区
                if (filter.includes(city.text)) {
                    // 用第三级区域数据补充，当前城市对应的区域数据
                    const tmps = areas.filter(area => area.parentCode === city.code);
                    tmps.forEach(tmp => {
                        // 下面这个判断没用到
                        const isBanShiChu = tmp.text.indexOf('办事处') > -1
                        res[formatCode(tmp.code)] = isBanShiChu ? tmp.text.slice(0, -3) : tmp.text;
                    })
                } else {
                    res[formatCode(city.code)] = city.text;
                }
            });
            pca[pcode] = res;
        }
    });
    // 省市联动，provinces & citys
    writeFileSync('pca.js', pca);
}

// 因为部分原处于第三级的区域提升到第二级，所以要重新抓取这部分区域对应的下一级区域数据
let url = '';
async function getAreasByCCode (page, code, text, isFix) {
    const pCode = code.substr(0, 2);
    const cCodeSuffix = code.substr(2, 2);
    if (isFix) {
        url = target.replace('#{route}', `${pCode}/${code.slice(0,4)}`);
    } else {
        url = target.replace('#{route}', `${pCode}/${cCodeSuffix}/${code}`);
    }
    
    await page.goto(url);
    let res = [];

    spinner.text = console.log(chalk.blue(`正在抓取 ${text} 的县区数据：${url}`));

    res = await page.evaluate((text) => {
        let list = [...document.querySelectorAll('.countytable .countytr')];
        if (!list.length) {
            console.log(`抓取失败${text}数据失败，用其他选择器抓取中……`)
            // 修正海南省-儋州市的区域数据
            list = [...document.querySelectorAll('.towntable .towntr')];
            if (!list.length) {
                console.log(`\n\n${text} 下没有县区数据\n\n`);
            } else {
                console.log(`\n抓取成功`)
            }
        }

        return list.map(el => {
            const t = el.innerText.split('\t');
            return {
                code: t[0],
                text: t[1]
            }
        });
    }, text);

    return res;
}

// 省市区联动
async function formatPCAAddress () {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // 保留市辖区
    const f = filter.slice(1);
    for (let p = 0, pl = pcodes.length; p < pl; p++) {
        const pcode = pcodes[p];
        if (pcode === '710000') {
            // 台湾
            pcaa[pcode] = provinces[pcode];
            pcaa['710100'] = provinces['710100'];
        } else if (pcode === '910000') {
            // 港澳
            const t = provinces[pcode];
            pcaa[pcode] = t;
            Object.keys(t).forEach(item => {
                pcaa[item] = provinces[item];
            });
        } else {
            const res = {};
            const pcities = cities.filter(city => city.parentCode === pcode);
            for(let c = 0, cl = pcities.length; c < cl; c++) {
                const pcity = pcities[c];
                const pareas = areas.filter(area => area.parentCode === pcity.code);
                // 包含 '县', '省直辖县级行政区划', '自治区直辖县级行政区划'
                if (f.includes(pcity.text)) {
                    console.log('特别县市，需要爬取数据', pcode, pcity)
                    // 特别县市，需要爬取数据 410000
                    // Object {code: "419000000000", text: "省直辖县级行政区划", parentCode: "410000"}
                    // 特别县市，需要爬取数据 420000
                    // Object {code: "429000000000", text: "省直辖县级行政区划", parentCode: "420000"}
                    // 特别县市，需要爬取数据 460000
                    // Object {code: "469000000000", text: "省直辖县级行政区划", parentCode: "460000"}
                    // 特别县市，需要爬取数据 500000
                    // Object {code: "500200000000", text: "县", parentCode: "500000"}
                    // 特别县市，需要爬取数据 650000
                    // Object {code: "659000000000", text: "自治区直辖县级行政区划", parentCode: "650000"}

                    // 用第三级区域数据补充到第二级
                    for(let i = 0, l = pareas.length; i < l; i++) {
                        const pCurAreas = {};
                        const parea = pareas[i];
                        const code = formatCode(parea.code);
                        res[code] = parea.text.indexOf('办事处') > -1 ? parea.text.slice(0, -3) : parea.text;

                        // 抓取第三级数据
                        let [err, data] = await awaitTo(getAreasByCCode(page, code, res[code]));
                        if (err) {
                            // 这个重试主要是处理因避免耗时(Navigation Timeout Exceeded)导致的错误
                            console.log('\n', chalk.red(`抓取数据失败，失败链接: ${url}，错误信息: ${err.message}，正在重试....\n`));
                            [err, data] = await awaitTo(getAreasByCCode(page, code, res[code]));
                        }
                        spinner.succeed(chalk.green(`市级城市 ${res[code]} 的县区数据抓取完毕.`));

                        if (data.length) {
                            console.log('ddddd', data[0]);
                            data.forEach(item => {
                                if (item.text !== '市辖区') {
                                    pCurAreas[formatCode(item.code)] = item.text.indexOf('办事处') > -1 ? item.text.slice(0, -3) : item.text;
                                }
                            });
                            pcaa[code] = pCurAreas;
                        }
                        await timeout(1500);
                    }
                } else {
                    const curAreas = {};
                    const cityCode = formatCode(pcity.code);
                    res[cityCode] = pcity.text;

                    if(pareas.length <= 0) {
                        console.log('数据验证失败：', pcity)
                    }
                    // 第三级数据
                    pareas.forEach(parea => {
                        if (parea.text !== '市辖区') {
                            if (parea.text.indexOf('办事处') > -1) {
                                curAreas[formatCode(parea.code, pcity.text)] = parea.text.slice(0, -3)
                            } else {
                                curAreas[formatCode(parea.code, pcity.text)] = parea.text
                            }
                        }
                    });
                    pcaa[cityCode] = curAreas;
                }
            }
            pcaa[pcode] = res;
        }
    }

    
    //可能有数据还没爬完，等待30s再关闭
    setTimeout(async () => {
        writeFileSync('pcaa.js', pcaa);
        await browser.close();

        // 必须生成数据后再修复填充 {} 数据
        await fillData()
    }, 30 * 1000)
}

//抓取省市区数据有空数据{}的情况
async function fillData() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    const pcaaObj = require('./pcaa.js');
    console.log(`载入数据成功`, pcaaObj)
    for(const temp in pcaaObj) {
        if(is.isEmptyObj(pcaaObj[temp])) {
            console.log('查找pcaa空数据，key为', temp)
            if (temp.length === 6) { // 这里都是6位
                const pCurAreas = {};
                let [err, data] = await awaitTo(getAreasByCCode(page, temp, temp, true));
                if (err) {
                    // 这个重试主要是处理因避免耗时(Navigation Timeout Exceeded)导致的错误
                    console.log('\n', chalk.red(`抓取数据失败，失败链接: ${url}，错误信息: ${err.message}，正在重试....\n`));
                    [err, data] = await awaitTo(getAreasByCCode(page, temp, temp, true));
                }
                spinner.succeed(chalk.green(`市级城市 ${temp} 的县区数据抓取完毕.`));
                if (data.length) {
                    console.log('抓取数据为', data);
                    data.forEach(item => {
                        if (item.text !== '市辖区') {
                            pCurAreas[formatCode(item.code)] = item.text.indexOf('办事处') > -1 ? item.text.slice(0, -3) : item.text;
                        }
                    });
                    pcaaObj[temp] = pCurAreas;
                } else {
                    console.log(chalk.red(`抓取 ${temp} 的县区数据失败`))
                }
                await timeout(200);
            } else {
                console.log('区号不是6位', temp)
            }
        }
    }
    setTimeout(async () => {
        writeFileSync('pcaa.js', pcaaObj);
        await browser.close();
    }, 30 * 1000)
}

// formatPCAddress();
// formatPCAAddress();
// fillData()
