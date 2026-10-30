/* Local-only sketch: three reused shapes and one SVG layer, never one map marker per vertex. */
(function(root){
  'use strict';
  class ZonePreview {
    constructor({map,maps,LatLng,document:doc=root.document,requestFrame,cancelFrame,enabled=()=>true}) {
      this.map=map;this.LatLng=LatLng;this.points=[];this.cursor=null;this.frame=null;this.lastPaint=-Infinity;this.disposed=false;this.enabled=enabled;
      this.requestFrame=requestFrame||(root.requestAnimationFrame?root.requestAnimationFrame.bind(root):fn=>setTimeout(()=>fn(Date.now()),34));
      this.cancelFrame=cancelFrame||(root.cancelAnimationFrame?root.cancelAnimationFrame.bind(root):clearTimeout);
      this.fill=new maps.Polygon({paths:[],strokeOpacity:0,fillOpacity:0.2,clickable:false,zIndex:2});
      this.line=new maps.Polyline({path:[],strokeWeight:3,clickable:false,zIndex:3});
      this.guide=new maps.Polyline({path:[],strokeOpacity:0,strokeWeight:2,clickable:false,zIndex:3});
      const owner=this;
      this.vertices=new class extends maps.OverlayView {
        onAdd(){
          if(owner.disposed)return;
          this.svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');this.nodes=[];
          this.svg.setAttribute('width','1');this.svg.setAttribute('height','1');this.svg.setAttribute('aria-hidden','true');
          Object.assign(this.svg.style,{position:'absolute',left:'0',top:'0',overflow:'visible',pointerEvents:'none'});
          this.getPanes().floatPane.append(this.svg);
        }
        draw(){
          if(!this.svg||owner.disposed)return;
          const projection=this.getProjection();if(!projection)return;
          while(this.nodes.length>owner.points.length)this.nodes.pop().remove();
          if(this.color!==owner.color){this.svg.setAttribute('fill',owner.color);this.color=owner.color;}
          for(let i=0;i<owner.points.length;i++){
            if(!this.nodes[i]){const circle=doc.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('r',i===0?'7':'5');circle.setAttribute('stroke','#fff');circle.setAttribute('stroke-width',i===0?'3':'2');this.svg.append(circle);this.nodes.push(circle);}
            const point=projection.fromLatLngToDivPixel(owner.points[i]),circle=this.nodes[i];
            if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)){circle.setAttribute('visibility','hidden');continue;}
            circle.setAttribute('visibility','visible');circle.setAttribute('cx',String(point.x));circle.setAttribute('cy',String(point.y));
          }
        }
        onRemove(){this.svg?.remove();this.svg=null;this.nodes=[];}
      }();
      this.vertices.setMap(map);
      this.listeners=[map.addListener('mousemove',event=>this.move(event.latLng)),map.addListener('mouseout',()=>this.clearCursor()),map.addListener('dragstart',()=>this.clearCursor())];
    }
    set(points,color){
      if(this.disposed)return;
      if(points.length>500)throw new Error('Strefa potrzebuje od 3 do 500 punktów.');
      this.cancelPending();this.cursor=null;this.color=color;this.lastPaint=-Infinity;
      this.points=points.map(([lng,lat])=>new this.LatLng(lat,lng));
      this.fill.setOptions({fillColor:color});this.fill.setPaths(this.points);
      this.line.setOptions({strokeColor:color});this.line.setPath(this.points);this.show(this.line,this.points.length>1);
      this.guide.setOptions({icons:[{icon:{path:'M 0,-1 0,1',strokeColor:color,strokeOpacity:1,scale:2},offset:'0',repeat:'12px'}]});
      this.guide.setPath(this.points.length>2?[this.points.at(-1),this.points[0]]:[]);
      this.show(this.guide,this.points.length>2);this.show(this.fill,this.points.length>2);
      this.hasCursor=false;this.vertices.draw();
    }
    cancelPending(){if(this.frame!==null){this.cancelFrame(this.frame);this.frame=null;}}
    isStart(position){
      if(this.disposed||!this.enabled()||this.points.length<3||!position)return false;
      const projection=this.vertices.getProjection();if(!projection)return false;
      const first=projection.fromLatLngToDivPixel(this.points[0]),point=projection.fromLatLngToDivPixel(position);
      return !!first&&!!point&&Number.isFinite(first.x)&&Number.isFinite(first.y)&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&Math.hypot(first.x-point.x,first.y-point.y)<=10;
    }
    show(shape,visible){const map=visible?this.map:null;if(shape.getMap()!==map)shape.setMap(map);}
    move(position){
      if(this.disposed||!this.points.length||!position||!this.enabled())return;
      const lat=typeof position.lat==='function'?position.lat():position.lat,lng=typeof position.lng==='function'?position.lng():position.lng;
      if(!Number.isFinite(lat)||!Number.isFinite(lng))return;
      if(this.cursor?.lat===lat&&this.cursor?.lng===lng)return;
      if(!this.cursor)this.cursor={lat,lng};else{this.cursor.lat=lat;this.cursor.lng=lng;}
      this.schedule();
    }
    schedule(){
      if(this.frame!==null||this.disposed)return;
      this.frame=this.requestFrame(time=>{
        this.frame=null;if(this.disposed)return;
        if(!this.enabled()){this.clearCursor();return;}
        if(time-this.lastPaint<32){this.schedule();return;}
        this.lastPaint=time;this.paintCursor();
      });
    }
    paintCursor(){
      if(!this.cursor||!this.points.length)return;
      const position=new this.LatLng(this.cursor.lat,this.cursor.lng);
      if(this.hasCursor){
        this.fill.getPath().setAt(this.points.length,position);this.guide.getPath().setAt(1,position);
      }else{
        this.fill.setPaths([...this.points,position]);
        this.guide.setPath([this.points.at(-1),position,...(this.points.length>1?[this.points[0]]:[])]);
        this.hasCursor=true;
      }
      this.show(this.fill,this.points.length>1);this.show(this.guide,true);
    }
    clearCursor(){
      if(this.disposed)return;
      this.cancelPending();this.cursor=null;
      if(!this.hasCursor)return;
      this.fill.setPaths(this.points);this.guide.setPath(this.points.length>2?[this.points.at(-1),this.points[0]]:[]);
      this.show(this.fill,this.points.length>2);this.show(this.guide,this.points.length>2);this.hasCursor=false;
    }
    dispose(){
      if(this.disposed)return;this.disposed=true;this.cancelPending();
      for(const listener of this.listeners)listener?.remove();this.listeners=[];
      this.vertices.setMap(null);this.fill.setMap(null);this.line.setMap(null);this.guide.setMap(null);
      this.points=[];this.cursor=null;
    }
  }
  root.ZonePreview=ZonePreview;
})(globalThis);
